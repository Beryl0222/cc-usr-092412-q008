// 贡献合议与发布冻结：事件溯源式的院务荣誉合议服务。
// 所有业务变化都以事件追加表达；资质更正、同意撤回、撤回发布都不会删除历史决议。
import { validateEvent } from "./validator.js";

// 主刀、护理、转诊、研究支持四类专业
export const SPECIALTIES = ["surgery", "nursing", "referral", "research"];
const MATERIAL_ACTIONS = ["replace", "correct", "retract"];

let deterministicSeq = 0;

function assert(condition, message, code) {
  if (!condition) {
    const error = new Error(message);
    error.code = code;
    throw error;
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonical(value[key]);
        return acc;
      }, {});
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(canonical(value));
}

function parseDate(value, field) {
  const time = Date.parse(value);
  assert(Number.isFinite(time), `${field} 必须是合法时间`, "invalid_date");
  return time;
}

// 提名候选贡献：必须指向具体工作事实、当时有效资质、可公开证据
function evaluateNomination(state, input) {
  const { contributionId, person, specialty, workFact, qualification, evidence } = input;
  assert(contributionId, "缺少 contributionId", "invalid_input");
  assert(!state.contributions.has(contributionId), `贡献已存在：${contributionId}`, "duplicate");
  assert(person && person.personId && person.name, "候选贡献必须指向具体人员", "invalid_person");
  assert(SPECIALTIES.includes(specialty), `未知专业领域：${specialty}`, "invalid_specialty");

  assert(workFact && typeof workFact.description === "string" && workFact.description.trim(),
    "候选贡献必须指向具体工作事实", "missing_work_fact");
  const factTime = parseDate(workFact.occurred_on, "workFact.occurred_on");

  assert(qualification && qualification.qualificationId, "必须声明当时有效资质", "missing_qualification");
  const from = parseDate(qualification.valid_from, "qualification.valid_from");
  const to = qualification.valid_to ? parseDate(qualification.valid_to, "qualification.valid_to") : null;
  assert(from <= factTime && (to === null || factTime < to),
    "资质在工作事实发生时不在有效期内", "qualification_not_effective");

  assert(evidence && evidence.evidenceId && evidence.kind, "必须提供可公开证据", "missing_evidence");
  assert(typeof evidence.public_ref === "string" && evidence.public_ref.trim(),
    "证据必须具备可公开定位（public_ref）", "evidence_not_public");
  if (evidence.patient_case_id) {
    assert(Array.isArray(evidence.requires_scope) && evidence.requires_scope.length > 0,
      "涉及患者案例的证据必须声明展示范围 requires_scope", "missing_scope");
  }
  return { person, specialty, workFact, qualification, evidence, factTime };
}

// 同名人员只产生归并提示，绝不自动合并人员身份
function sameNameHints(state, contributionId, person) {
  const events = [];
  for (const other of state.contributions.values()) {
    if (other.personId !== person.personId && other.name === person.name) {
      const pair = [contributionId, other.id].sort();
      const hintKey = pair.join("|");
      if (!state.hintKeys.has(hintKey)) {
        state.hintKeys.add(hintKey);
        events.push({ hintKey, contributionIds: pair, name: person.name });
      }
    }
  }
  return events;
}

export function initialState() {
  return {
    caseId: null,
    title: null,
    opened: false,
    sealed: false,
    contributions: new Map(),
    consents: new Map(), // grantId -> grant with frozen version
    hints: [],
    hintKeys: new Set(),
    overlaps: [],
    omissions: [],
    materials: new Map(),
    effectiveRoster: null,
    rosterHistory: [],
    heldSignings: [],
    archiveSealedAt: null,
  };
}

export function applyEvent(state, event) {
  const d = event.details ?? {};
  switch (event.event_type) {
    case "HONOR_CASE_OPENED":
      state.caseId = d.case_id;
      state.title = d.title;
      state.opened = true;
      break;
    case "CONTRIBUTION_NOMINATED": {
      state.contributions.set(d.contribution_id, {
        id: d.contribution_id,
        personId: d.person.person_id,
        name: d.person.name,
        specialty: d.specialty,
        workFact: d.work_fact,
        qualification: d.qualification,
        qualificationHistory: [{ at: event.occurred_at, qualification: d.qualification }],
        evidence: { ...d.evidence, masked: null },
        status: "nominated",
        confirmations: [],
        disputes: [],
        overlapDecision: null,
      });
      break;
    }
    case "SAME_NAME_HINT_RECORDED":
      state.hints.push({ key: d.hint_key, contributionIds: d.contribution_ids, name: d.name });
      break;
    case "FACT_CONFIRMED": {
      const c = state.contributions.get(d.contribution_id);
      if (!c.confirmations.some((x) => x.repId === d.rep_id)) {
        c.confirmations.push({ repId: d.rep_id, at: event.occurred_at });
      }
      c.status = "confirmed";
      break;
    }
    case "CONSENT_GRANTED":
      state.consents.set(d.grant_id, {
        grantId: d.grant_id,
        patientCaseId: d.patient_case_id,
        versionId: d.version_id,
        scope: [...d.scope],
        grantedAt: d.granted_at,
        frozen: null,
        withdrawn: null,
      });
      break;
    case "CONSENT_VERSION_FROZEN": {
      const grant = state.consents.get(d.grant_id);
      grant.frozen = { versionId: d.version_id, scope: [...d.scope], at: event.occurred_at };
      break;
    }
    case "CONSENT_WITHDRAWN": {
      const grant = state.consents.get(d.grant_id);
      grant.withdrawn = { at: event.occurred_at };
      break;
    }
    case "EVIDENCE_MASKED": {
      const c = state.contributions.get(d.contribution_id);
      c.evidence.masked = { reason: d.reason, at: event.occurred_at };
      break;
    }
    case "QUALIFICATION_CORRECTED": {
      const c = state.contributions.get(d.contribution_id);
      c.qualification = d.qualification;
      c.qualificationHistory.push({ at: event.occurred_at, qualification: d.qualification });
      break;
    }
    case "OVERLAP_FLAGGED":
      state.overlaps.push({ factId: d.fact_id, contributionIds: [...d.contribution_ids], resolution: null });
      break;
    case "OVERLAP_RESOLVED": {
      const overlap = state.overlaps.find((o) => o.factId === d.fact_id && !o.resolution);
      overlap.resolution = { include: d.include, exclude: d.exclude, rationale: d.rationale, at: event.occurred_at };
      for (const id of d.exclude) {
        const c = state.contributions.get(id);
        if (c) c.overlapDecision = "excluded";
      }
      break;
    }
    case "OMISSION_FLAGGED":
      state.omissions.push({ omissionId: d.omission_id, description: d.description, resolution: null });
      break;
    case "OMISSION_RESOLVED": {
      const omission = state.omissions.find((o) => o.omissionId === d.omission_id && !o.resolution);
      omission.resolution = { action: d.action, contributionId: d.contribution_id ?? null, rationale: d.rationale, at: event.occurred_at };
      break;
    }
    case "DISPUTE_FILED": {
      const c = state.contributions.get(d.contribution_id);
      c.disputes.push({ disputeId: d.dispute_id, reason: d.reason, status: "open", decision: null, at: event.occurred_at });
      c.status = "disputed";
      break;
    }
    case "DISPUTE_RESOLVED": {
      const c = state.contributions.get(d.contribution_id);
      const dispute = c.disputes.find((x) => x.disputeId === d.dispute_id);
      dispute.status = "resolved";
      dispute.decision = d.decision;
      dispute.resolvedAt = event.occurred_at;
      c.status = d.decision === "remove" ? "removed" : "confirmed";
      break;
    }
    case "ROSTER_SIGNED": {
      const roster = {
        version: d.roster_version,
        receiptId: d.receipt_id,
        signer: d.signer,
        entries: [...d.entry_ids],
        excluded: [...(d.excluded ?? [])],
        hash: d.hash,
        signedAt: event.occurred_at,
        status: "effective",
      };
      if (state.effectiveRoster) {
        const previous = state.rosterHistory.find((r) => r.version === state.effectiveRoster.version);
        if (previous) previous.status = "superseded";
        state.effectiveRoster.status = "superseded";
      }
      state.rosterHistory.push(roster);
      state.effectiveRoster = roster;
      break;
    }
    case "SIGNING_HELD":
      state.heldSignings.push({
        heldId: d.held_id,
        receiptId: d.receipt_id,
        entryIds: [...d.entry_ids],
        hash: d.hash,
        reason: d.reason,
        at: event.occurred_at,
        resolution: null,
      });
      break;
    case "HELD_SIGNING_RESOLVED": {
      const held = state.heldSignings.find((h) => h.heldId === d.held_id);
      held.resolution = { decision: d.decision, rationale: d.rationale, at: event.occurred_at };
      break;
    }
    case "MATERIAL_DRAFTED":
      state.materials.set(d.material_id, {
        id: d.material_id,
        contributionId: d.contribution_id,
        includesPatientCase: d.includes_patient_case,
        published: false,
        status: "draft",
        dispositions: [],
        pendingEffects: [],
      });
      break;
    case "STORY_RELEASED": {
      const m = state.materials.get(d.material_id);
      m.published = true;
      m.status = "published";
      m.publishedAt = event.occurred_at;
      break;
    }
    case "MATERIAL_ACTION_REQUIRED": {
      const m = state.materials.get(d.material_id);
      if (m && m.status !== "retracted" && m.status !== "replaced"
        && !m.pendingEffects.some((e) => stableStringify(e) === stableStringify(d.effect))) {
        m.pendingEffects.push(d.effect);
      }
      break;
    }
    case "MATERIAL_REPLACED":
    case "MATERIAL_CORRECTED":
    case "MATERIAL_RETRACTED": {
      const m = state.materials.get(d.material_id);
      const action = event.event_type === "MATERIAL_REPLACED" ? "replace"
        : event.event_type === "MATERIAL_CORRECTED" ? "correct" : "retract";
      m.dispositions.push({
        action,
        reason: d.reason,
        replacementMaterialId: d.replacement_material_id ?? null,
        at: event.occurred_at,
      });
      m.pendingEffects = [];
      if (action === "replace") m.status = "replaced";
      if (action === "retract") m.status = "retracted";
      if (action === "correct") m.status = "published_corrected";
      break;
    }
    case "ARCHIVE_SEALED":
      state.sealed = true;
      state.archiveSealedAt = event.occurred_at;
      break;
    default:
      break;
  }
  return state;
}

function replay(events) {
  return events.reduce((state, event) => applyEvent(state, event), initialState());
}

class HonorAdjudicationService {
  constructor({ clock = () => new Date().toISOString() } = {}) {
    this.clock = clock;
    this.events = [];
    this.state = initialState();
    this.receipts = new Map(); // receiptId -> { hash, result }
  }

  version() {
    return this.events.length;
  }

  append(eventType, aggregateType, aggregateId, details, summary) {
    const event = {
      event_id: `${this.state.caseId ?? "case"}-${this.events.length + 1}-${eventType.toLowerCase()}`,
      event_type: eventType,
      aggregate_type: aggregateType,
      aggregate_id: aggregateId,
      occurred_at: this.clock(),
      version: this.events.length + 1,
      summary,
      details,
    };
    const errors = validateEvent(event);
    assert(errors.length === 0, `事件信封不合法：${errors.join("；")}`, "invalid_event");
    this.events.push(event);
    applyEvent(this.state, event);
    return event;
  }

  requireOpen() {
    assert(this.state.opened, "荣誉案件尚未建立", "case_not_open");
  }

  openCase({ caseId, title }) {
    assert(caseId && title, "缺少 caseId 或 title", "invalid_input");
    assert(!this.state.opened, "荣誉案件已建立", "duplicate");
    return this.append("HONOR_CASE_OPENED", "honor_case", caseId,
      { case_id: caseId, title }, `建立荣誉案件：${title}`);
  }

  // ---- 候选贡献与同名提示 -------------------------------------------------

  nominateContribution(input) {
    this.requireOpen();
    const produced = [];
    const evaluated = evaluateNomination(this.state, input);
    const { contributionId, person, specialty, workFact, qualification, evidence } = {
      contributionId: input.contributionId,
      ...evaluated,
    };
    produced.push(this.append("CONTRIBUTION_NOMINATED", "contribution_record", contributionId, {
      contribution_id: contributionId,
      person: { person_id: person.personId, name: person.name },
      specialty,
      work_fact: { description: workFact.description, occurred_on: workFact.occurred_on },
      qualification,
      evidence,
    }, `登记候选贡献：${person.name}（${specialty}）`));

    for (const hint of sameNameHints(this.state, contributionId, person)) {
      produced.push(this.append("SAME_NAME_HINT_RECORDED", "honor_case", this.state.caseId, {
        hint_key: hint.hintKey,
        contribution_ids: hint.contributionIds,
        name: hint.name,
      }, `检测到同名人员，仅作归并提示：${hint.name}`));
    }
    return produced;
  }

  // ---- 专业代表确认本领域事实 ---------------------------------------------

  confirmFacts({ repId, specialties, contributionIds }) {
    this.requireOpen();
    assert(repId && Array.isArray(specialties) && Array.isArray(contributionIds),
      "缺少代表身份、专业范围或贡献清单", "invalid_input");
    const produced = [];
    for (const id of contributionIds) {
      const c = this.state.contributions.get(id);
      assert(c, `贡献不存在：${id}`, "not_found");
      assert(specialties.includes(c.specialty),
        `代表只能确认本专业事实，${repId} 不能确认 ${c.specialty}`, "specialty_forbidden");
      if (c.confirmations.some((x) => x.repId === repId)) continue;
      if (c.status === "disputed" || c.status === "removed") continue;
      produced.push(this.append("FACT_CONFIRMED", "contribution_record", id, {
        contribution_id: id,
        rep_id: repId,
        rep_specialties: specialties,
      }, `${repId} 确认本专业事实：${id}`));
    }
    return produced;
  }

  // ---- 患者同意版本 -------------------------------------------------------

  grantConsent({ grantId, patientCaseId, versionId, scope, grantedAt }) {
    this.requireOpen();
    assert(grantId && patientCaseId && versionId && Array.isArray(scope) && scope.length,
      "同意授权必须包含患者案例、版本与展示范围", "invalid_input");
    assert(!this.state.consents.has(grantId), `同意授权已存在：${grantId}`, "duplicate");
    parseDate(grantedAt, "grantedAt");
    return this.append("CONSENT_GRANTED", "consent_grant", grantId, {
      grant_id: grantId,
      patient_case_id: patientCaseId,
      version_id: versionId,
      scope,
      granted_at: grantedAt,
    }, `登记患者案例同意版本：${patientCaseId}@${versionId}`);
  }

  // 涉及患者案例的展示范围冻结当时同意版本
  freezeConsentVersion({ grantId, scope }) {
    this.requireOpen();
    const grant = this.state.consents.get(grantId);
    assert(grant, `同意授权不存在：${grantId}`, "not_found");
    assert(!grant.withdrawn, "同意已被撤回，不能冻结展示范围", "consent_withdrawn");
    const frozenScope = scope ?? grant.scope;
    return this.append("CONSENT_VERSION_FROZEN", "consent_grant", grantId, {
      grant_id: grantId,
      patient_case_id: grant.patientCaseId,
      version_id: grant.versionId,
      scope: frozenScope,
    }, `冻结患者案例展示范围：${grant.patientCaseId}@${grant.versionId}`);
  }

  // 同意撤回不删除历史，只遮罩证据并要求处置材料
  withdrawConsent({ grantId, reason = "患者撤回公开案例的同意" }) {
    this.requireOpen();
    const grant = this.state.consents.get(grantId);
    assert(grant, `同意授权不存在：${grantId}`, "not_found");
    assert(!grant.withdrawn, `同意已撤回：${grantId}`, "duplicate");
    const produced = [this.append("CONSENT_WITHDRAWN", "consent_grant", grantId, {
      grant_id: grantId,
      patient_case_id: grant.patientCaseId,
      reason,
    }, `患者撤回同意：${grant.patientCaseId}`)];

    for (const c of this.state.contributions.values()) {
      if (c.evidence.patient_case_id === grant.patientCaseId && !c.evidence.masked) {
        produced.push(this.append("EVIDENCE_MASKED", "contribution_record", c.id, {
          contribution_id: c.id,
          evidence_id: c.evidence.evidenceId,
          reason,
        }, `遮罩不再授权的患者案例证据：${c.evidence.evidenceId}`));
        produced.push(...this.#flagMaterials(c.id, { type: "consent_withdrawal", grant_id: grantId }));
      }
    }
    return produced;
  }

  // ---- 荣誉委员会：重叠、遗漏、异议 ---------------------------------------

  flagOverlap({ factId, contributionIds, reason }) {
    this.requireOpen();
    assert(Array.isArray(contributionIds) && contributionIds.length >= 2, "重叠至少涉及两项贡献", "invalid_input");
    for (const id of contributionIds) assert(this.state.contributions.has(id), `贡献不存在：${id}`, "not_found");
    return this.append("OVERLAP_FLAGGED", "honor_case", this.state.caseId, {
      fact_id: factId, contribution_ids: contributionIds, reason,
    }, `委员会标记工作事实重叠：${factId}`);
  }

  resolveOverlap({ factId, include, exclude, rationale }) {
    this.requireOpen();
    const overlap = this.state.overlaps.find((o) => o.factId === factId && !o.resolution);
    assert(overlap, `没有待决的重叠事项：${factId}`, "not_found");
    for (const id of [...include, ...exclude]) assert(this.state.contributions.has(id), `贡献不存在：${id}`, "not_found");
    return this.append("OVERLAP_RESOLVED", "honor_case", this.state.caseId, {
      fact_id: factId, include, exclude, rationale,
    }, `委员会裁决重叠：${factId}`);
  }

  flagOmission({ omissionId, description }) {
    this.requireOpen();
    assert(omissionId && description, "遗漏事项需要标识与说明", "invalid_input");
    return this.append("OMISSION_FLAGGED", "honor_case", this.state.caseId, {
      omission_id: omissionId, description,
    }, `委员会登记可能的协作者遗漏：${omissionId}`);
  }

  resolveOmission({ omissionId, action, contributionId, rationale }) {
    this.requireOpen();
    const omission = this.state.omissions.find((o) => o.omissionId === omissionId && !o.resolution);
    assert(omission, `没有待决的遗漏事项：${omissionId}`, "not_found");
    assert(["add_contribution", "dismiss"].includes(action), "遗漏裁决必须是 add_contribution 或 dismiss", "invalid_input");
    if (action === "add_contribution") assert(this.state.contributions.has(contributionId), `贡献不存在：${contributionId}`, "not_found");
    return this.append("OMISSION_RESOLVED", "honor_case", this.state.caseId, {
      omission_id: omissionId, action, contribution_id: contributionId ?? null, rationale,
    }, `委员会裁决遗漏：${omissionId}`);
  }

  fileDispute({ disputeId, contributionId, reason }) {
    this.requireOpen();
    const c = this.state.contributions.get(contributionId);
    assert(c, `贡献不存在：${contributionId}`, "not_found");
    assert(disputeId && reason, "异议需要标识与理由", "invalid_input");
    return this.append("DISPUTE_FILED", "contribution_record", contributionId, {
      dispute_id: disputeId, contribution_id: contributionId, reason,
    }, `提出异议，暂停争议贡献：${contributionId}`);
  }

  resolveDispute({ disputeId, contributionId, decision, rationale }) {
    this.requireOpen();
    const c = this.state.contributions.get(contributionId);
    assert(c, `贡献不存在：${contributionId}`, "not_found");
    const dispute = c.disputes.find((x) => x.disputeId === disputeId && x.status === "open");
    assert(dispute, `没有待决异议：${disputeId}`, "not_found");
    assert(["uphold", "remove"].includes(decision), "异议裁决必须是 uphold 或 remove", "invalid_input");
    return this.append("DISPUTE_RESOLVED", "contribution_record", contributionId, {
      dispute_id: disputeId, contribution_id: contributionId, decision, rationale,
    }, `委员会裁决异议：${disputeId} -> ${decision}`);
  }

  // 资质更正保留历史链路，并要求受影响材料作出处置
  correctQualification({ contributionId, qualification }) {
    this.requireOpen();
    const c = this.state.contributions.get(contributionId);
    assert(c, `贡献不存在：${contributionId}`, "not_found");
    parseDate(qualification.valid_from, "qualification.valid_from");
    if (qualification.valid_to) parseDate(qualification.valid_to, "qualification.valid_to");
    const event = this.append("QUALIFICATION_CORRECTED", "contribution_record", contributionId, {
      contribution_id: contributionId, qualification,
    }, `更正资质记录（历史资质保留）：${contributionId}`);
    const flagged = this.#flagMaterials(contributionId, { type: "qualification_correction", at: event.occurred_at });
    return [event, ...flagged];
  }

  // ---- 并发签署：一版生效、相同回执重放、内容变化待核 ----------------------

  #evaluateRosterEntries(entryIds) {
    const included = [];
    const excluded = [];
    for (const id of entryIds) {
      const c = this.state.contributions.get(id);
      assert(c, `贡献不存在：${id}`, "not_found");
      if (c.status === "disputed") {
        excluded.push({ contribution_id: id, reason: "disputed_paused" });
        continue;
      }
      if (c.status === "removed" || c.overlapDecision === "excluded") {
        excluded.push({ contribution_id: id, reason: c.status === "removed" ? "removed_by_dispute" : "excluded_by_overlap" });
        continue;
      }
      if (c.confirmations.length === 0) {
        excluded.push({ contribution_id: id, reason: "fact_not_confirmed" });
        continue;
      }
      if (c.evidence.patient_case_id) {
        const grant = [...this.state.consents.values()]
          .find((g) => g.patientCaseId === c.evidence.patient_case_id);
        if (!grant || !grant.frozen) {
          excluded.push({ contribution_id: id, reason: "consent_version_not_frozen" });
          continue;
        }
        const missing = c.evidence.requires_scope.filter((s) => !grant.frozen.scope.includes(s));
        if (missing.length) {
          excluded.push({ contribution_id: id, reason: "scope_beyond_frozen_consent", missing_scope: missing });
          continue;
        }
      }
      included.push(id);
    }
    return { included, excluded };
  }

  signRoster({ receiptId, expectedVersion, signer, entries }) {
    this.requireOpen();
    assert(receiptId && signer && Array.isArray(entries) && entries.length, "签署需要回执、签署人和名单条目", "invalid_input");
    const entryIds = entries.map((e) => e.contribution_id ?? e);
    const hash = stableStringify({ entryIds: [...entryIds].sort() });

    // 完全相同的回执可重放：不产生新事件、新版本
    const known = this.receipts.get(receiptId);
    if (known) {
      if (known.hash === hash) return { replayed: true, roster: known.result, events: [] };
      // 同一回执但内容变化：保留待核
      return { held: this.#holdSigning(receiptId, entryIds, hash, "receipt_content_changed") };
    }

    if (Number.isInteger(expectedVersion) && expectedVersion !== this.version()) {
      // 并发冲突：内容与已生效名单完全一致则视为重放，否则保留待核
      if (this.state.effectiveRoster && this.state.effectiveRoster.hash === hash) {
        this.receipts.set(receiptId, { hash, result: this.state.effectiveRoster });
        return { replayed: true, roster: this.state.effectiveRoster, events: [] };
      }
      return { held: this.#holdSigning(receiptId, entryIds, hash, "concurrent_content_changed", expectedVersion) };
    }

    const { included, excluded } = this.#evaluateRosterEntries(entryIds);
    if (included.length === 0) {
      // 全部条目被暂停或不满足发布条件：不产生生效名单，返回阻断明细
      return { roster: null, blocked: true, events: [], excluded };
    }
    const rosterVersion = this.state.rosterHistory.length + 1;
    const event = this.append("ROSTER_SIGNED", "honor_case", this.state.caseId, {
      roster_version: rosterVersion,
      receipt_id: receiptId,
      signer,
      entry_ids: included,
      excluded,
      hash,
    }, `签署生效名单 v${rosterVersion}（${signer}）`);
    const roster = this.state.effectiveRoster;
    this.receipts.set(receiptId, { hash, result: roster });
    return { roster, events: [event], excluded };
  }

  #holdSigning(receiptId, entryIds, hash, reason, expectedVersion) {
    deterministicSeq += 1;
    const heldId = `held-${this.version()}-${deterministicSeq}`;
    const event = this.append("SIGNING_HELD", "honor_case", this.state.caseId, {
      held_id: heldId,
      receipt_id: receiptId,
      entry_ids: entryIds,
      expected_version: expectedVersion ?? null,
      hash,
      reason,
    }, `并发签署内容变化，保留待核：${receiptId}（${reason}）`);
    return this.state.heldSignings[this.state.heldSignings.length - 1];
  }

  // 委员会对待核签署作出复核：accept 形成新生效版本，reject 留痕驳回
  resolveHeldSigning({ heldId, decision, rationale, signer }) {
    this.requireOpen();
    const held = this.state.heldSignings.find((h) => h.heldId === heldId && !h.resolution);
    assert(held, `没有待核的签署记录：${heldId}`, "not_found");
    assert(["accept", "reject"].includes(decision), "复核结论必须是 accept 或 reject", "invalid_input");
    const produced = [this.append("HELD_SIGNING_RESOLVED", "honor_case", this.state.caseId, {
      held_id: heldId, decision, rationale,
    }, `委员会复核待核签署：${heldId} -> ${decision}`)];
    if (decision === "accept") {
      const { included, excluded } = this.#evaluateRosterEntries(held.entryIds);
      assert(included.length > 0, "待核名单没有可生效条目", "roster_empty");
      const rosterVersion = this.state.rosterHistory.length + 1;
      produced.push(this.append("ROSTER_SIGNED", "honor_case", this.state.caseId, {
        roster_version: rosterVersion,
        receipt_id: `${held.receiptId}#verified`,
        signer: signer ?? "honor_committee",
        entry_ids: included,
        excluded,
        hash: held.hash,
        from_held_id: heldId,
      }, `待核签署复核通过，生效名单 v${rosterVersion}`));
    }
    return produced;
  }

  // ---- 材料准备、发布与事后处置 -------------------------------------------

  draftMaterial({ materialId, contributionId, includesPatientCase = false }) {
    this.requireOpen();
    assert(this.state.contributions.has(contributionId), `贡献不存在：${contributionId}`, "not_found");
    assert(!this.state.materials.has(materialId), `材料已存在：${materialId}`, "duplicate");
    return this.append("MATERIAL_DRAFTED", "public_story", materialId, {
      material_id: materialId, contribution_id: contributionId, includes_patient_case: includesPatientCase,
    }, `登记未发布材料：${materialId}`);
  }

  publishMaterials({ materialIds }) {
    this.requireOpen();
    assert(this.state.effectiveRoster, "尚无生效名单，不能发布", "roster_missing");
    const produced = [];
    for (const id of materialIds) {
      const m = this.state.materials.get(id);
      assert(m, `材料不存在：${id}`, "not_found");
      assert(m.status === "draft", `材料不是待发布草稿：${id}（${m.status}）`, "invalid_material_state");
      assert(this.state.effectiveRoster.entries.includes(m.contributionId),
        `材料对应贡献不在生效名单中：${id}`, "not_on_roster");
      const c = this.state.contributions.get(m.contributionId);
      assert(!(m.includesPatientCase && (!c.evidence.patient_case_id || c.evidence.masked)),
        `患者案例材料未获当前授权：${id}`, "consent_not_effective");
      produced.push(this.append("STORY_RELEASED", "public_story", id, {
        material_id: id,
        contribution_id: m.contributionId,
        roster_version: this.state.effectiveRoster.version,
      }, `公开发布材料：${id}`));
    }
    return produced;
  }

  #flagMaterials(contributionId, effect) {
    const produced = [];
    for (const m of this.state.materials.values()) {
      if (m.contributionId === contributionId && m.status !== "retracted" && m.status !== "replaced"
        && !m.pendingEffects.some((e) => stableStringify(e) === stableStringify(effect))) {
        produced.push(this.append("MATERIAL_ACTION_REQUIRED", "public_story", m.id, {
          material_id: m.id,
          contribution_id: contributionId,
          effect,
        }, `材料需根据新情况处置：${m.id}`));
      }
    }
    return produced;
  }

  // 未发布材料只能替换；已发布材料只能更正或撤回
  disposeMaterial({ materialId, action, reason, replacementMaterialId }) {
    this.requireOpen();
    const m = this.state.materials.get(materialId);
    assert(m, `材料不存在：${materialId}`, "not_found");
    assert(MATERIAL_ACTIONS.includes(action), "处置必须是 replace、correct 或 retract", "invalid_input");
    assert(m.pendingEffects.length, "该材料没有需要处置的资质更正或同意撤回", "no_pending_effect");
    if (action === "replace") {
      assert(!m.published, `材料已发布，不能替换，只能更正或撤回：${materialId}`, "already_published");
      if (replacementMaterialId) {
        const replacement = this.state.materials.get(replacementMaterialId);
        assert(replacement && !replacement.published, "替换材料必须是未发布草稿", "invalid_replacement");
      }
    } else {
      assert(m.published, `材料尚未发布，应当替换而不是${action === "correct" ? "更正" : "撤回"}：${materialId}`, "not_published");
    }
    const eventType = action === "replace" ? "MATERIAL_REPLACED"
      : action === "correct" ? "MATERIAL_CORRECTED" : "MATERIAL_RETRACTED";
    return this.append(eventType, "public_story", materialId, {
      material_id: materialId,
      action,
      reason,
      replacement_material_id: replacementMaterialId ?? null,
    }, `材料处置 ${action}：${materialId}`);
  }

  // ---- 最终档案：内部记录与公开说明分离 -----------------------------------

  buildArchive() {
    this.requireOpen();
    const roster = this.state.effectiveRoster;
    assert(roster, "尚无生效名单，不能封存档案", "roster_missing");

    const internalContributions = [...this.state.contributions.values()].map((c) => ({
      contribution_id: c.id,
      person: { person_id: c.personId, name: c.name },
      specialty: c.specialty,
      status: c.status,
      granted_because: {
        work_fact: c.workFact,
        qualification_effective_at_fact: c.qualificationHistory[0].qualification,
        confirmed_by: c.confirmations,
      },
      qualification_corrections: c.qualificationHistory.slice(1),
      evidence: {
        evidence_id: c.evidence.evidenceId,
        kind: c.evidence.kind,
        public_ref: c.evidence.public_ref,
        patient_case_id: c.evidence.patient_case_id ?? null,
        masked: c.evidence.masked,
      },
      disputes: c.disputes,
      overlap_decision: c.overlapDecision,
    }));

    const internalMaterials = [...this.state.materials.values()].map((m) => ({
      material_id: m.id,
      contribution_id: m.contributionId,
      includes_patient_case: m.includesPatientCase,
      published: m.published,
      status: m.status,
      pending_effects: m.pendingEffects,
      dispositions: m.dispositions,
    }));

    const undecided = internalMaterials.filter((m) => m.pending_effects.length > 0);

    const frozenConsent = [...this.state.consents.values()]
      .filter((g) => g.frozen)
      .map((g) => ({
        grant_id: g.grantId, patient_case_id: g.patientCaseId,
        frozen_version: g.frozen.versionId, frozen_scope: g.frozen.scope,
        withdrawn_at: g.withdrawn?.at ?? null,
      }));

    // 公开说明：只出现生效名单、可公开且未遮罩的证据，以及必须公开的更正/撤回告示
    const honorees = roster.entries.map((id) => {
      const c = this.state.contributions.get(id);
      const materials = [...this.state.materials.values()].filter((m) => m.contributionId === id && m.published);
      const notices = materials.flatMap((m) => m.dispositions
        .filter((x) => x.action === "correct" || x.action === "retract")
        .map((x) => ({ material_id: m.id, action: x.action, reason: x.reason, at: x.at })));
      return {
        name: c.name,
        specialty: c.specialty,
        contribution_summary: c.workFact.description,
        evidence_refs: c.evidence.masked ? [] : [c.evidence.public_ref],
        public_notices: notices,
      };
    });

    return {
      case_id: this.state.caseId,
      title: this.state.title,
      roster_version: roster.version,
      sealed_at: this.state.archiveSealedAt,
      internal: {
        roster: { version: roster.version, entries: roster.entries, excluded: roster.excluded, signed_at: roster.signedAt },
        contributions: internalContributions,
        materials: internalMaterials,
        frozen_consent: frozenConsent,
        same_name_hints: this.state.hints,
        overlaps: this.state.overlaps,
        omissions: this.state.omissions,
        held_signings: this.state.heldSignings,
      },
      public: {
        title: this.state.title,
        roster_version: roster.version,
        honorees,
      },
    };
  }

  sealArchive() {
    const preview = this.buildArchive();
    const undecided = preview.internal.materials.filter((m) => m.pending_effects.length > 0);
    assert(undecided.length === 0,
      `仍有材料未就资质更正/同意撤回作出处置：${undecided.map((m) => m.material_id).join("、")}`,
      "disposition_pending");
    const event = this.append("ARCHIVE_SEALED", "honor_case", this.state.caseId, {
      case_id: this.state.caseId,
      roster_version: preview.roster_version,
    }, "封存最终档案：内部贡献记录与公开说明分离");
    const archive = this.buildArchive();
    return { event, archive };
  }

  getPausedContributions() {
    return [...this.state.contributions.values()].filter((c) => c.status === "disputed").map((c) => c.id);
  }

  getSameNameHints() {
    return this.state.hints;
  }

  getEffectiveRoster() {
    return this.state.effectiveRoster;
  }
}

export { HonorAdjudicationService, replay, stableStringify };
