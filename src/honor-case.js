import { createHash } from "node:crypto";

import { validateEvent } from "./validator.js";

// ---------------------------------------------------------------------------
// 事件重放：只追加、不原地改写。任何业务不变量被破坏时抛出错误，错误中带事件标识。
// ---------------------------------------------------------------------------

const CONTRIBUTION_TERMINAL_STATUSES = new Set(["rejected", "merged"]);

export function replay(events) {
  const state = emptyState();
  for (const event of events) apply(state, event);
  return state;
}

export function emptyState() {
  return {
    events: [],
    profiles: new Map(),
    contributions: new Map(),
    consentGrants: new Map(),
    stories: new Map(),
    materials: new Map(),
    cases: new Map(),
    rosters: new Map(), // keyed by honor_case_id
    seenEventIds: new Set(),
    aggregateVersions: new Map(),
  };
}

export function apply(state, event) {
  const errors = validateEvent(event);
  if (errors.length) throw new Error(`事件 ${event.event_id ?? "?"} 校验失败：${errors.join("；")}`);

  if (state.seenEventIds.has(event.event_id)) {
    throw new Error(`事件标识重复：${event.event_id}`);
  }

  const expectedVersion = (state.aggregateVersions.get(event.aggregate_id) ?? 0) + 1;
  if (event.version !== expectedVersion) {
    throw new Error(
      `事件 ${event.event_id} 版本断裂：聚合 ${event.aggregate_id} 期望 v${expectedVersion}，收到 v${event.version}`,
    );
  }
  state.aggregateVersions.set(event.aggregate_id, event.version);
  state.seenEventIds.add(event.event_id);
  state.events.push(event);

  const handler = HANDLERS[event.event_type];
  if (handler) handler(state, event);
  return state;
}

// 将规划器产出的事件草稿（只有类型/聚合/payload）补齐为正式事件并重放。
// occurred_at 可注入以便重放确定性场景。
export function commit(state, draft, { event_id, occurred_at, causation_id, summary } = {}) {
  const seq = state.events.length + 1;
  const version = (state.aggregateVersions.get(draft.aggregate_id) ?? 0) + 1;
  const event = {
    event_id: event_id ?? `evt-${String(seq).padStart(3, "0")}`,
    event_type: draft.event_type,
    aggregate_type: draft.aggregate_type,
    aggregate_id: draft.aggregate_id,
    occurred_at: occurred_at ?? new Date().toISOString(),
    version,
    summary: summary ?? draft.summary ?? draft.event_type,
    payload: draft.payload ?? {},
  };
  if (causation_id) event.causation_id = causation_id;
  return apply(state, event);
}

export function commitAll(state, drafts, { occurred_at } = {}) {
  for (const draft of drafts) commit(state, draft, { occurred_at });
  return state;
}

// ---------------------------------------------------------------------------
// 归约器
// ---------------------------------------------------------------------------

const HANDLERS = {
  PROFILE_REGISTERED(state, event) {
    state.profiles.set(event.aggregate_id, { id: event.aggregate_id, ...event.payload });
  },

  CONTRIBUTION_ATTESTED(state, event) {
    const p = event.payload;
    const case_ = ensureCase(state, p.honor_case_id);
    const contribution = {
      id: event.aggregate_id,
      case_id: p.honor_case_id,
      person: p.person ?? null,
      domain: p.domain,
      work_fact: p.work_fact,
      credential_at_time: p.credential_at_time,
      public_evidence: p.public_evidence ?? [],
      status: "candidate",
      confirmed_by: null,
      open_objections: new Set(),
      objection_history: [],
      superseded_by: null,
      corrections: [],
    };
    state.contributions.set(contribution.id, contribution);
    case_.contributionIds.push(contribution.id);
    registerMaterials(state, contribution.id, null, contribution.public_evidence);
  },

  ATTRIBUTION_CORRECTED(state, event) {
    const c = mustContribution(state, event.aggregate_id, event);
    // 更正只追加：历史确认与决议不删除
    c.corrections.push({
      correction_id: event.payload.correction_id,
      reason: event.payload.reason,
      credential_at_time: event.payload.credential_at_time ?? null,
      at: event.occurred_at,
    });
  },

  NAME_MATCH_SUGGESTED(state, event) {
    const case_ = mustCase(state, event.aggregate_id, event);
    case_.suggestions.push({
      contribution_ids: event.payload.contribution_ids,
      reason: event.payload.reason ?? "同名人员，仅提示，需人工确认是否同一人",
      at: event.occurred_at,
    });
  },

  FACT_CONFIRMED(state, event) {
    const p = event.payload;
    const c = mustContribution(state, p.contribution_id, event);
    if (c.domain !== p.domain) {
      throw new Error(
        `事件 ${event.event_id}：${p.domain} 专业代表不能确认 ${c.domain} 领域的贡献 ${c.id}`,
      );
    }
    c.status = "confirmed";
    c.confirmed_by = { rep: p.confirmed_by, domain: p.domain, at: event.occurred_at };
  },

  OVERLAP_RESOLVED(state, event) {
    const case_ = mustCase(state, event.aggregate_id, event);
    const { contribution_ids, decision } = event.payload;
    const keptId = decision.kept;
    if (!contribution_ids.includes(keptId)) {
      throw new Error(`事件 ${event.event_id}：重叠决议保留的贡献不在候选集合内`);
    }
    for (const id of contribution_ids) {
      const c = mustContribution(state, id, event);
      if (id !== keptId && !decision.shares?.[id]) {
        // 并入保留项的重复贡献标记 merged；声明贡献份额的保留为独立条目
        c.status = "merged";
        c.superseded_by = keptId;
      }
    }
    case_.decisions.push({ kind: "overlap", ...event.payload, at: event.occurred_at });
  },

  OMISSION_ADDED(state, event) {
    const case_ = mustCase(state, event.aggregate_id, event);
    const c = mustContribution(state, event.payload.contribution_id, event);
    if (!case_.contributionIds.includes(c.id)) case_.contributionIds.push(c.id);
    case_.decisions.push({
      kind: "omission",
      contribution_id: c.id,
      note: event.payload.note ?? "委员会补充的遗漏协作者",
      at: event.occurred_at,
    });
  },

  OBJECTION_FILED(state, event) {
    const case_ = mustCase(state, event.aggregate_id, event);
    const p = event.payload;
    if (case_.objections.has(p.objection_id)) {
      throw new Error(`事件 ${event.event_id}：异议 ${p.objection_id} 已存在`);
    }
    for (const id of p.contribution_ids) {
      const c = mustContribution(state, id, event);
      c.open_objections.add(p.objection_id);
      c.objection_history.push(p.objection_id);
    }
    case_.objections.set(p.objection_id, {
      id: p.objection_id,
      contribution_ids: [...p.contribution_ids],
      reason: p.reason,
      status: "open",
      decision: null,
      filed_at: event.occurred_at,
      resolved_at: null,
    });
  },

  OBJECTION_RESOLVED(state, event) {
    const case_ = mustCase(state, event.aggregate_id, event);
    const o = case_.objections.get(event.payload.objection_id);
    if (!o) throw new Error(`事件 ${event.event_id}：异议不存在`);
    if (o.status !== "open") throw new Error(`事件 ${event.event_id}：异议已了结，不能重复处置`);
    o.status = "resolved";
    o.decision = event.payload.decision; // upheld | dismissed
    o.resolved_at = event.occurred_at;

    for (const id of o.contribution_ids) {
      const c = state.contributions.get(id);
      c.open_objections.delete(o.id);
      if (event.payload.decision === "upheld" && c.status !== "merged") c.status = "rejected";
      if (event.payload.decision === "dismissed" && c.confirmed_by) c.status = "confirmed";
    }
  },

  CONSENT_GRANTED(state, event) {
    state.consentGrants.set(event.aggregate_id, {
      id: event.aggregate_id,
      patient_id: event.payload.patient_id,
      version: event.payload.consent_version,
      scope: event.payload.scope,
      withdrawn: false,
      history: [{ version: event.payload.consent_version, at: event.occurred_at, kind: "granted" }],
    });
  },

  CONSENT_WITHDRAWN(state, event) {
    const g = mustGrant(state, event.aggregate_id, event);
    g.withdrawn = true;
    g.withdrawn_scope = event.payload.effective_scope;
    g.history.push({ at: event.occurred_at, kind: "withdrawn", scope: event.payload.effective_scope });
  },

  CONSENT_VERSION_FROZEN(state, event) {
    const case_ = mustCase(state, event.aggregate_id, event);
    const g = mustGrant(state, event.payload.consent_grant_id, event);
    if (g.version !== event.payload.consent_version) {
      throw new Error(`事件 ${event.event_id}：冻结的同意版本与授权记录当前版本不一致`);
    }
    // 冻结的是当时版本快照；之后撤回不改变快照本身
    case_.frozenConsent = {
      grant_id: g.id,
      version: g.version,
      scope: structuredClone(g.scope),
      frozen_at: event.occurred_at,
    };
  },

  STORY_RELEASED(state, event) {
    const p = event.payload;
    state.stories.set(event.aggregate_id, { id: event.aggregate_id, ...p, released_at: event.occurred_at });
    registerMaterials(
      state,
      p.contribution_id ?? null,
      event.aggregate_id,
      [{ material_id: p.material_id, requires_consent: p.requires_consent ?? null }],
      true,
    );
    for (const ref of p.mask_refs ?? []) {
      const m = state.materials.get(ref.material_id ?? ref);
      if (m) m.published = true;
    }
  },

  ROSTER_SIGNING_HELD(state, event) {
    const roster = ensureRoster(state, event.payload.honor_case_id);
    const p = event.payload;
    roster.receipts.set(p.receipt_id, {
      receipt_id: p.receipt_id,
      content_hash: p.content_hash,
      status: p.status,
      reason: p.reason ?? null,
      at: event.occurred_at,
    });
  },

  ROSTER_EFFECTIVE(state, event) {
    const p = event.payload;
    const roster = ensureRoster(state, p.honor_case_id);
    if (roster.effective && roster.effective.content_hash !== p.content_hash) {
      throw new Error(`事件 ${event.event_id}：该荣誉案已有不同内容的生效名单，一案只允许一版生效`);
    }
    const case_ = mustCase(state, p.honor_case_id, event);
    const expectedHash = rosterContentHash(p.honor_case_id, eligibleEntries(state, p.honor_case_id), case_.frozenConsent);
    if (expectedHash !== p.content_hash) {
      throw new Error(
        `事件 ${event.event_id}：名单内容哈希与当前合议状态不一致（并发变更须保留待核，不能直接生效）`,
      );
    }
    roster.effective = {
      receipt_id: p.receipt_id,
      content_hash: p.content_hash,
      entry_ids: [...p.entry_ids],
      snapshot: snapshotEntries(state, p.honor_case_id, p.entry_ids),
      at: event.occurred_at,
    };
    roster.receipts.set(p.receipt_id, {
      receipt_id: p.receipt_id,
      content_hash: p.content_hash,
      status: "effective",
      at: event.occurred_at,
    });
  },

  MATERIAL_REPLACED(state, event) {
    pushDisposition(state, event, "replaced");
  },
  MATERIAL_CORRECTED(state, event) {
    pushDisposition(state, event, "corrected");
  },
  MATERIAL_WITHDRAWN(state, event) {
    pushDisposition(state, event, "withdrawn");
  },

  PUBLIC_NOTICE_PUBLISHED(state, event) {
    const roster = ensureRoster(state, event.payload.honor_case_id);
    roster.notices.push({ notice: event.payload.notice, at: event.occurred_at });
  },
};

function pushDisposition(state, event, kind) {
  const p = event.payload;
  for (const ref of p.mask_refs ?? []) {
    const id = typeof ref === "string" ? ref : ref.material_id;
    const m = state.materials.get(id);
    if (!m) throw new Error(`事件 ${event.event_id}：被处置材料 ${id} 不存在`);
    m.dispositions.push({
      kind,
      reason: p.reason,
      material_id: p.material_id ?? id,
      replacement: p.replacement ?? null,
      at: event.occurred_at,
      aggregate_id: event.aggregate_id,
    });
  }
}

// ---------------------------------------------------------------------------
// 查询与决策
// ---------------------------------------------------------------------------

export function caseContributions(state, caseId) {
  const case_ = state.cases.get(caseId);
  if (!case_) return [];
  return case_.contributionIds.map((id) => state.contributions.get(id));
}

// 生效候选：本领域代表已确认事实、无未决异议、未被否决或归并；
// 依赖患者授权的材料在授权已撤回时同样不得进入（撤回即触发争议暂停）。
export function eligibleEntries(state, caseId) {
  return caseContributions(state, caseId)
    .filter((c) => c.status === "confirmed" && c.open_objections.size === 0)
    .filter((c) => !consentBlocked(state, c))
    .map((c) => ({
      contribution_id: c.id,
      person_ref: c.person?.ref ?? c.id,
      name: c.person?.name ?? null,
      domain: c.domain,
      role: c.person?.role ?? null,
    }))
    .sort((a, b) => a.contribution_id.localeCompare(b.contribution_id));
}

export function openDisputedIds(state, caseId) {
  return new Set(
    caseContributions(state, caseId)
      .filter((c) => c.open_objections.size > 0 || consentBlocked(state, c))
      .map((c) => c.id),
  );
}

export function detectNameClashes(state, caseId) {
  // 同名自动归并只能作为提示：按姓名归组但 person_ref 不同即提示
  const byName = new Map();
  for (const c of caseContributions(state, caseId)) {
    if (!c.person?.name) continue;
    const key = c.person.name.replace(/\s+/g, "");
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(c);
  }
  return [...byName.values()]
    .filter((group) => new Set(group.map((c) => c.person.ref)).size > 1)
    .map((group) => group.map((c) => c.id).sort());
}

export function rosterContentHash(caseId, entries, frozenConsent) {
  const canonical = JSON.stringify({
    case: caseId,
    entries: entries.map((e) => ({
      contribution_id: e.contribution_id,
      person_ref: e.person_ref,
      domain: e.domain,
    })),
    consent: frozenConsent ? { grant: frozenConsent.grant_id, version: frozenConsent.version } : null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

// 并发接收入口：完全相同的回执重放；内容变化或已有他版生效则保留待核。
// 返回 {outcome: 'effective'|'replay'|'held', event?}
export function receiveSigningReceipt(state, receipt) {
  const { receipt_id, honor_case_id, entries } = receipt;
  const case_ = state.cases.get(honor_case_id);
  if (!case_) throw new Error(`荣誉案不存在：${honor_case_id}`);

  const content_hash = rosterContentHash(honor_case_id, canonicalEntries(entries), case_.frozenConsent);
  const roster = ensureRoster(state, honor_case_id);

  if (usesPatientMaterial(state, honor_case_id) && !case_.frozenConsent) {
    return {
      outcome: "held",
      content_hash,
      event: heldEvent(receipt, content_hash, "CONSENT_NOT_FROZEN", "涉及患者案例，尚未冻结当时同意版本，不能签署"),
    };
  }

  const prior = roster.receipts.get(receipt_id);

  // 完全相同的回执可安全重放
  if (prior && prior.content_hash === content_hash) {
    return { outcome: "replay", effective: roster.effective, content_hash };
  }
  // 同一回执标识但内容变化：保留待核
  if (prior && prior.content_hash !== content_hash) {
    return {
      outcome: "held",
      content_hash,
      event: heldEvent(receipt, content_hash, "CONTENT_CHANGED_PENDING_REVIEW", "同一回执标识对应内容已变化，保留待核"),
    };
  }
  // 已有生效版本
  if (roster.effective) {
    if (roster.effective.content_hash === content_hash) {
      return { outcome: "replay", effective: roster.effective, content_hash };
    }
    return {
      outcome: "held",
      content_hash,
      event: heldEvent(receipt, content_hash, "ANOTHER_VERSION_EFFECTIVE_PENDING_REVIEW", "已存在生效名单，并发签署的不同内容保留待核"),
    };
  }

  // 与当前合议状态一致方可生效（并发期间出现异议会使哈希失配）
  const currentHash = rosterContentHash(honor_case_id, eligibleEntries(state, honor_case_id), case_.frozenConsent);
  if (currentHash !== content_hash) {
    return {
      outcome: "held",
      content_hash,
      event: heldEvent(receipt, content_hash, "STALE_VIEW_PENDING_REVIEW", "回执内容与当前合议结果不一致（可能并发变更），保留待核"),
    };
  }

  const entryIds = canonicalEntries(entries).map((e) => e.contribution_id);
  return {
    outcome: "effective",
    content_hash,
    event: {
      event_type: "ROSTER_EFFECTIVE",
      aggregate_type: "honor_roster",
      aggregate_id: `roster-${honor_case_id}`,
      payload: { honor_case_id, receipt_id, content_hash, entry_ids: entryIds },
    },
  };
}

// 资质更正的处置决策：历史决议保留；未发布材料替换，已发布材料更正并遮罩旧证据。
export function planCredentialCorrection(state, cmd) {
  const c = state.contributions.get(cmd.contribution_id);
  if (!c) throw new Error(`贡献不存在：${cmd.contribution_id}`);
  const events = [
    {
      event_type: "ATTRIBUTION_CORRECTED",
      aggregate_type: "contribution_record",
      aggregate_id: c.id,
      payload: {
        correction_id: cmd.correction_id,
        reason: cmd.reason,
        credential_at_time: cmd.credential_at_time ?? null,
      },
    },
  ];

  const roster = state.rosters.get(c.case_id);
  const publishedMaterials = materialsOf(state, c.id).filter((m) => m.published);
  const unpublishedMaterials = materialsOf(state, c.id).filter((m) => !m.published);

  if (unpublishedMaterials.length) {
    events.push({
      event_type: "MATERIAL_REPLACED",
      aggregate_type: "contribution_record",
      aggregate_id: c.id,
      payload: {
        material_id: unpublishedMaterials[0].id,
        reason: `资质更正：${cmd.reason}；未发布材料在发布前替换`,
        mask_refs: unpublishedMaterials.map((m) => m.id),
        replacement: cmd.replacement ?? null,
      },
    });
  }
  if (publishedMaterials.length) {
    const storyId = publishedMaterials[0].story_id;
    events.push({
      event_type: "MATERIAL_CORRECTED",
      aggregate_type: "public_story",
      aggregate_id: storyId,
      payload: {
        material_id: publishedMaterials[0].id,
        reason: `资质更正：${cmd.reason}；已发布材料作更正并遮罩旧资质证据`,
        mask_refs: publishedMaterials.map((m) => m.id),
        replacement: cmd.replacement ?? null,
      },
    });
    if (roster?.effective) {
      events.push({
        event_type: "PUBLIC_NOTICE_PUBLISHED",
        aggregate_type: "honor_roster",
        aggregate_id: `roster-${c.case_id}`,
        payload: {
          honor_case_id: c.case_id,
          notice: `更正说明：${c.person?.name ?? c.id} 相关展示中的资质信息已更新，历史决议保留。`,
        },
      });
    }
  }
  return events;
}

// 同意撤回的处置决策：不删除历史；暂停关联贡献（不阻断团队其余部分）；
// 未发布材料替换，已发布材料撤回并公告。
export function planConsentWithdrawal(state, cmd) {
  const g = state.consentGrants.get(cmd.consent_grant_id);
  if (!g) throw new Error(`同意记录不存在：${cmd.consent_grant_id}`);
  const events = [
    {
      event_type: "CONSENT_WITHDRAWN",
      aggregate_type: "consent_grant",
      aggregate_id: g.id,
      payload: { patient_id: g.patient_id, effective_scope: cmd.effective_scope ?? "all" },
    },
  ];

  const affected = [...state.materials.values()]
    .filter((m) => m.requires_consent === g.id)
    .filter((m) => !m.dispositions.some((d) => d.kind === "replaced" || d.kind === "withdrawn"));

  const byCase = new Map();
  for (const m of affected) {
    const c = state.contributions.get(m.contribution_id);
    if (!c) continue;
    if (!byCase.has(c.case_id)) byCase.set(c.case_id, new Set());
    byCase.get(c.case_id).add(c.id);
  }

  for (const [caseId, ids] of byCase) {
    events.push({
      event_type: "OBJECTION_FILED",
      aggregate_type: "honor_case",
      aggregate_id: caseId,
      payload: {
        objection_id: `objection-consent-${g.id}-${caseId}`,
        contribution_ids: [...ids].sort(),
        reason: "患者撤回案例公开同意，暂停关联贡献的公开展示（仅暂停争议贡献）",
      },
    });
  }

  for (const m of affected) {
    if (!m.published) {
      events.push({
        event_type: "MATERIAL_REPLACED",
        aggregate_type: "contribution_record",
        aggregate_id: m.contribution_id,
        payload: {
          material_id: m.id,
          reason: "同意撤回：未发布材料以去标识化版本替换",
          mask_refs: [m.id],
          replacement: { deidentified: true },
        },
      });
    } else {
      events.push({
        event_type: "MATERIAL_WITHDRAWN",
        aggregate_type: "public_story",
        aggregate_id: m.story_id,
        payload: { material_id: m.id, reason: "患者撤回公开同意，撤回已发布材料", mask_refs: [m.id] },
      });
      const c = state.contributions.get(m.contribution_id);
      if (c && state.rosters.get(c.case_id)?.effective) {
        events.push({
          event_type: "PUBLIC_NOTICE_PUBLISHED",
          aggregate_type: "honor_roster",
          aggregate_id: `roster-${c.case_id}`,
          payload: {
            honor_case_id: c.case_id,
            notice: "撤回公告：应患者要求，相关案例展示材料已撤回，团队其余荣誉内容不受影响。",
          },
        });
      }
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// 档案投影：内部贡献记录 vs 公开说明
// ---------------------------------------------------------------------------

export function internalCaseRecord(state, caseId) {
  const case_ = state.cases.get(caseId);
  if (!case_) throw new Error(`荣誉案不存在：${caseId}`);
  return {
    case_id: caseId,
    frozen_consent: case_.frozenConsent
      ? { ...case_.frozenConsent, scope: structuredClone(case_.frozenConsent.scope) }
      : null,
    name_suggestions: case_.suggestions,
    contributions: caseContributions(state, caseId).map((c) => ({
      contribution_id: c.id,
      person: c.person,
      domain: c.domain,
      work_fact: c.work_fact,
      credential_at_time: c.credential_at_time,
      public_evidence: c.public_evidence,
      status: c.status,
      confirmed_by: c.confirmed_by,
      open_objections: [...c.open_objections],
      objection_history: c.objection_history,
      superseded_by: c.superseded_by,
      corrections: c.corrections,
      materials: materialsOf(state, c.id).map(materialView),
    })),
    committee_decisions: case_.decisions,
    objections: [...case_.objections.values()],
    roster: rosterView(state, caseId),
  };
}

export function publicStatement(state, caseId) {
  const roster = state.rosters.get(caseId);
  if (!roster?.effective) return { case_id: caseId, published: false, entries: [], notices: [] };

  const disputed = openDisputedIds(state, caseId);
  const entries = roster.effective.snapshot
    .filter((snap) => !disputed.has(snap.contribution_id))
    .map((snap) => {
      const c = state.contributions.get(snap.contribution_id);
      return {
        name: snap.name,
        domain: snap.domain,
        role: snap.role,
        work_fact: publicWorkFact(c.work_fact),
        evidence: publicEvidence(state, c),
        consent_version: consentLabelFor(state, c),
      };
    });

  return {
    case_id: caseId,
    published: true,
    roster_version: roster.effective.content_hash.slice(0, 12),
    entries,
    notices: roster.notices.map((n) => ({ notice: n.notice, at: n.at })),
  };
}

// 还原每项荣誉为何授予、哪些证据被遮罩、后来如何处置
export function awardRationale(state, caseId) {
  const roster = state.rosters.get(caseId);
  if (!roster?.effective) return [];
  const case_ = state.cases.get(caseId);
  const disputed = openDisputedIds(state, caseId);

  return roster.effective.snapshot.map((snap) => {
    const c = state.contributions.get(snap.contribution_id);
    const relatedDecisions = case_.decisions.filter(
      (d) =>
        d.contribution_id === c.id ||
        d.contribution_ids?.includes(c.id) ||
        d.decision?.kept === c.id,
    );
    return {
      entry_id: c.id,
      name: snap.name,
      domain: snap.domain,
      awarded_because: c.work_fact,
      fact_confirmed_by: c.confirmed_by,
      committee_review: relatedDecisions,
      objections: case_.objections.size
        ? [...case_.objections.values()].filter((o) => o.contribution_ids.includes(c.id))
        : [],
      frozen_consent_snapshot: frozenConsentFor(state, c),
      evidence: publicEvidence(state, c),
      later_dispositions: materialsOf(state, c.id).flatMap((m) =>
        m.dispositions.map((d) => ({ material_id: m.id, ...d })),
      ),
      publication_status: disputed.has(c.id) ? "suspended_from_publication" : "published",
    };
  });
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

function consentBlocked(state, c) {
  return materialsOf(state, c.id).some((m) => {
    if (!m.requires_consent) return false;
    const g = state.consentGrants.get(m.requires_consent);
    return g?.withdrawn;
  });
}

function usesPatientMaterial(state, caseId) {
  return caseContributions(state, caseId).some((c) => materialsOf(state, c.id).some((m) => m.requires_consent));
}

function materialsOf(state, contributionId) {
  return [...state.materials.values()].filter((m) => m.contribution_id === contributionId);
}

function registerMaterials(state, contributionId, storyId, evidence, published = false) {
  for (const item of evidence ?? []) {
    if (typeof item === "string") continue;
    const id = item.material_id;
    if (!id) continue;
    const existing = state.materials.get(id);
    if (existing) {
      if (contributionId) existing.contribution_id = existing.contribution_id ?? contributionId;
      if (storyId) existing.story_id = storyId;
      existing.published = existing.published || published;
      continue;
    }
    state.materials.set(id, {
      id,
      contribution_id: contributionId,
      story_id: storyId,
      requires_consent: item.requires_consent ?? null,
      published,
      dispositions: [],
    });
  }
}

function materialView(m) {
  return {
    material_id: m.id,
    published: m.published,
    requires_consent: m.requires_consent,
    dispositions: m.dispositions,
  };
}

function publicEvidence(state, c) {
  return (c.public_evidence ?? []).map((item) => {
    if (typeof item === "string") return { ref: item, visible: true };
    const m = state.materials.get(item.material_id);
    const last = m?.dispositions.at(-1);
    if (last?.kind === "withdrawn") {
      return { ref: item.material_id, visible: false, masked: true, disposition: "withdrawn", reason: last.reason };
    }
    if (last && (last.kind === "corrected" || last.kind === "replaced")) {
      return {
        ref: item.material_id,
        visible: true,
        masked: true,
        disposition: last.kind,
        replacement: last.replacement,
      };
    }
    return { ref: item.material_id, visible: true, masked: false };
  });
}

function publicWorkFact(workFact) {
  if (typeof workFact === "string") return workFact;
  // 内部工作事实中的患者标识在公开侧剔除
  const { patient_id, patient_name, ...rest } = workFact;
  return rest;
}

function frozenConsentFor(state, c) {
  const case_ = state.cases.get(c.case_id);
  if (!case_.frozenConsent) return null;
  const needsConsent = materialsOf(state, c.id).some((m) => m.requires_consent);
  return needsConsent
    ? { grant_id: case_.frozenConsent.grant_id, version: case_.frozenConsent.version, scope: "frozen_snapshot" }
    : null;
}

function consentLabelFor(state, c) {
  const snap = frozenConsentFor(state, c);
  return snap ? `同意快照 ${snap.version}` : null;
}

function canonicalEntries(entries) {
  return [...entries]
    .map((e) => ({
      contribution_id: e.contribution_id,
      person_ref: e.person_ref ?? e.contribution_id,
      name: e.name ?? null,
      domain: e.domain,
      role: e.role ?? null,
    }))
    .sort((a, b) => a.contribution_id.localeCompare(b.contribution_id));
}

function heldEvent(receipt, content_hash, status, reason) {
  return {
    event_type: "ROSTER_SIGNING_HELD",
    aggregate_type: "honor_roster",
    aggregate_id: `roster-${receipt.honor_case_id}`,
    payload: {
      honor_case_id: receipt.honor_case_id,
      receipt_id: receipt.receipt_id,
      content_hash,
      status,
      reason,
    },
  };
}

function snapshotEntries(state, caseId, entryIds) {
  return entryIds
    .map((id) => {
      const c = state.contributions.get(id);
      return c
        ? {
            contribution_id: c.id,
            person_ref: c.person?.ref ?? c.id,
            name: c.person?.name ?? null,
            domain: c.domain,
            role: c.person?.role ?? null,
          }
        : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.contribution_id.localeCompare(b.contribution_id));
}

function rosterView(state, caseId) {
  const r = state.rosters.get(caseId);
  if (!r) return null;
  return {
    effective: r.effective
      ? {
          receipt_id: r.effective.receipt_id,
          content_hash: r.effective.content_hash,
          entry_ids: r.effective.entry_ids,
          effective_at: r.effective.at,
        }
      : null,
    held_receipts: [...r.receipts.values()].filter((x) => x.status !== "effective"),
    notices: r.notices,
  };
}

function ensureCase(state, id) {
  if (!state.cases.has(id)) state.cases.set(id, { id, contributionIds: [], suggestions: [], objections: new Map(), decisions: [], frozenConsent: null });
  return state.cases.get(id);
}
function ensureRoster(state, caseId) {
  if (!state.rosters.has(caseId)) state.rosters.set(caseId, { receipts: new Map(), effective: null, notices: [] });
  return state.rosters.get(caseId);
}
function mustCase(state, id, event) {
  const c = state.cases.get(id);
  if (!c) throw new Error(`事件 ${event.event_id}：荣誉案 ${id} 不存在`);
  return c;
}
function mustContribution(state, id, event) {
  const c = state.contributions.get(id);
  if (!c) throw new Error(`事件 ${event.event_id}：贡献 ${id} 不存在`);
  return c;
}
function mustGrant(state, id, event) {
  const g = state.consentGrants.get(id);
  if (!g) throw new Error(`事件 ${event.event_id}：同意记录 ${id} 不存在`);
  return g;
}
