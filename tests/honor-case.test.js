import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  apply,
  awardRationale,
  commit,
  commitAll,
  detectNameClashes,
  eligibleEntries,
  emptyState,
  internalCaseRecord,
  openDisputedIds,
  planConsentWithdrawal,
  planCredentialCorrection,
  publicStatement,
  receiveSigningReceipt,
  replay,
  rosterContentHash,
} from "../src/honor-case.js";

const T = "2026-09-22T09:00:00+08:00";
const CASE = "case-test";

function attestDraft(id, overrides = {}) {
  return {
    event_type: "CONTRIBUTION_ATTESTED",
    aggregate_type: "contribution_record",
    aggregate_id: id,
    payload: {
      honor_case_id: CASE,
      person: overrides.person ?? { ref: `p-${id}`, name: overrides.name ?? `人员${id}`, role: "协作者" },
      domain: overrides.domain ?? "surgery",
      work_fact: overrides.work_fact ?? { description: `事实 ${id}` },
      credential_at_time: overrides.credential_at_time ?? { license: "L-1", valid_to: "2030-01-01" },
      public_evidence: overrides.public_evidence ?? [{ material_id: `mat-${id}`, requires_consent: overrides.requires_consent ?? null }],
    },
  };
}

function buildHappyCase({ consent = false } = {}) {
  const state = emptyState();
  commit(state, attestDraft("c1", { domain: "surgery", name: "王医生" }), { event_id: "e1", occurred_at: T });
  commit(state, attestDraft("c2", { domain: "nursing", name: "林护士" }), { event_id: "e2", occurred_at: T });
  if (consent) {
    commit(
      state,
      attestDraft("c3", {
        domain: "research",
        name: "数据员",
        requires_consent: "consent-1",
        work_fact: { description: "随访数据集", patient_id: "P-1" },
      }),
      { event_id: "e3", occurred_at: T },
    );
    commit(
      state,
      {
        event_type: "CONSENT_GRANTED",
        aggregate_type: "consent_grant",
        aggregate_id: "consent-1",
        payload: { patient_id: "P-1", consent_version: "v1", scope: { case_display: true } },
      },
      { event_id: "e4", occurred_at: T },
    );
    commit(
      state,
      {
        event_type: "CONSENT_VERSION_FROZEN",
        aggregate_type: "honor_case",
        aggregate_id: CASE,
        payload: { consent_grant_id: "consent-1", consent_version: "v1", scope: { case_display: true } },
      },
      { event_id: "e5", occurred_at: T },
    );
  }
  const confirm = (id, domain, rep) =>
    commit(
      state,
      { event_type: "FACT_CONFIRMED", aggregate_type: "honor_case", aggregate_id: CASE, payload: { contribution_id: id, domain, confirmed_by: rep } },
      { event_id: `cf-${id}`, occurred_at: T },
    );
  confirm("c1", "surgery", "外科代表");
  confirm("c2", "nursing", "护理代表");
  if (consent) confirm("c3", "research", "研究代表");
  return state;
}

// ---------------------------------------------------------------------------

test("候选贡献三要素锚点缺失时被拒绝", () => {
  assert.throws(
    () =>
      apply(emptyState(), {
        event_id: "x1",
        event_type: "CONTRIBUTION_ATTESTED",
        aggregate_type: "contribution_record",
        aggregate_id: "c",
        occurred_at: T,
        version: 1,
        summary: "s",
        payload: {
          honor_case_id: CASE,
          domain: "surgery",
          work_fact: "",
          credential_at_time: null,
          public_evidence: [],
        },
      }),
    /work_fact|credential_at_time|public_evidence/,
  );
});

test("事件与聚合类型不匹配时被拒绝", () => {
  assert.throws(
    () =>
      apply(emptyState(), {
        event_id: "x2",
        event_type: "FACT_CONFIRMED",
        aggregate_type: "contribution_record",
        aggregate_id: "c",
        occurred_at: T,
        version: 1,
        summary: "s",
        payload: { contribution_id: "c", domain: "surgery", confirmed_by: "r" },
      }),
    /不能挂在聚合/,
  );
});

test("事件只追加：重复标识与版本断裂都被拒绝", () => {
  const state = buildHappyCase();
  const good = {
    event_id: "dup",
    event_type: "FACT_CONFIRMED",
    aggregate_type: "honor_case",
    aggregate_id: CASE,
    occurred_at: T,
    version: 4,
    summary: "s",
    payload: { contribution_id: "c1", domain: "surgery", confirmed_by: "r" },
  };
  assert.throws(() => apply(state, good), /版本断裂/);

  const s2 = emptyState();
  commit(s2, attestDraft("c1"), { event_id: "e1", occurred_at: T });
  commit(s2, attestDraft("c2"), { event_id: "e2", occurred_at: T });
  assert.throws(
    () =>
      apply(s2, {
        event_id: "e1",
        event_type: "PROFILE_REGISTERED",
        aggregate_type: "nominee_profile",
        aggregate_id: "n1",
        occurred_at: T,
        version: 1,
        summary: "s",
        payload: {},
      }),
    /事件标识重复/,
  );
});

test("同名人员只产生提示，不自动归并", () => {
  const state = emptyState();
  commit(state, attestDraft("c1", { person: { ref: "p-a", name: "张伟", role: "转诊" }, domain: "referral" }), { event_id: "e1", occurred_at: T });
  commit(state, attestDraft("c2", { person: { ref: "p-b", name: "张伟", role: "研究" }, domain: "research" }), { event_id: "e2", occurred_at: T });
  commit(
    state,
    { event_type: "NAME_MATCH_SUGGESTED", aggregate_type: "honor_case", aggregate_id: CASE, payload: { contribution_ids: ["c1", "c2"] } },
    { event_id: "e3", occurred_at: T },
  );
  assert.deepEqual(detectNameClashes(state, CASE), [["c1", "c2"]]);
  assert.equal(state.contributions.get("c1").status, "candidate");
  assert.equal(state.contributions.get("c2").status, "candidate");
});

test("专业代表只能确认本领域事实", () => {
  const state = buildHappyCase();
  assert.throws(
    () =>
      commit(
        state,
        {
          event_type: "FACT_CONFIRMED",
          aggregate_type: "honor_case",
          aggregate_id: CASE,
          payload: { contribution_id: "c1", domain: "nursing", confirmed_by: "越界代表" },
        },
        { occurred_at: T },
      ),
    /不能确认/,
  );
});

test("委员会处理重叠与遗漏", () => {
  const state = buildHappyCase();
  commit(state, attestDraft("c9", { domain: "surgery", name: "王医生" }), { event_id: "e9", occurred_at: T });
  commit(
    state,
    {
      event_type: "OVERLAP_RESOLVED",
      aggregate_type: "honor_case",
      aggregate_id: CASE,
      payload: { contribution_ids: ["c9", "c1"], decision: { kept: "c1" } },
    },
    { event_id: "ov1", occurred_at: T },
  );
  assert.equal(state.contributions.get("c9").status, "merged");
  assert.equal(state.contributions.get("c9").superseded_by, "c1");

  commit(state, attestDraft("c8", { domain: "anesthesia", name: "赵医生" }), { event_id: "e8", occurred_at: T });
  commit(
    state,
    { event_type: "OMISSION_ADDED", aggregate_type: "honor_case", aggregate_id: CASE, payload: { contribution_id: "c8" } },
    { event_id: "om1", occurred_at: T },
  );
  commit(
    state,
    { event_type: "FACT_CONFIRMED", aggregate_type: "honor_case", aggregate_id: CASE, payload: { contribution_id: "c8", domain: "anesthesia", confirmed_by: "麻醉代表" } },
    { event_id: "cf8", occurred_at: T },
  );
  assert.ok(eligibleEntries(state, CASE).some((e) => e.contribution_id === "c8"));
});

test("异议期间只暂停争议贡献，不阻断团队其余部分", () => {
  const state = buildHappyCase();
  commit(
    state,
    {
      event_type: "OBJECTION_FILED",
      aggregate_type: "honor_case",
      aggregate_id: CASE,
      payload: { objection_id: "o1", contribution_ids: ["c2"], reason: "护理工时记录存疑" },
    },
    { event_id: "obj1", occurred_at: T },
  );
  const disputed = openDisputedIds(state, CASE);
  assert.deepEqual([...disputed], ["c2"]);
  assert.deepEqual(
    eligibleEntries(state, CASE).map((e) => e.contribution_id),
    ["c1"],
  );

  // 异议被驳回后恢复
  commit(
    state,
    { event_type: "OBJECTION_RESOLVED", aggregate_type: "honor_case", aggregate_id: CASE, payload: { objection_id: "o1", decision: "dismissed" } },
    { event_id: "ores1", occurred_at: T },
  );
  assert.equal(state.contributions.get("c2").status, "confirmed");
  assert.deepEqual(openDisputedIds(state, CASE).size, 0);
});

test("异议成立则否决该贡献，历史记录仍保留", () => {
  const state = buildHappyCase();
  commit(
    state,
    { event_type: "OBJECTION_FILED", aggregate_type: "honor_case", aggregate_id: CASE, payload: { objection_id: "o2", contribution_ids: ["c2"], reason: "虚报" } },
    { event_id: "obj2", occurred_at: T },
  );
  commit(
    state,
    { event_type: "OBJECTION_RESOLVED", aggregate_type: "honor_case", aggregate_id: CASE, payload: { objection_id: "o2", decision: "upheld" } },
    { event_id: "ores2", occurred_at: T },
  );
  assert.equal(state.contributions.get("c2").status, "rejected");
  // 历史事实与确认仍可查
  assert.ok(state.contributions.get("c2").confirmed_by);
  assert.deepEqual(state.contributions.get("c2").objection_history, ["o2"]);
});

test("同意版本必须先冻结才能签署涉及患者材料的名单", () => {
  const state = buildHappyCase({ consent: true });
  const unfrozen = emptyState();
  commit(unfrozen, attestDraft("c3", { requires_consent: "consent-1" }), { event_id: "e3", occurred_at: T });
  commit(
    unfrozen,
    { event_type: "CONSENT_GRANTED", aggregate_type: "consent_grant", aggregate_id: "consent-1", payload: { patient_id: "P-1", consent_version: "v1", scope: {} } },
    { event_id: "e4", occurred_at: T },
  );
  commit(
    unfrozen,
    { event_type: "FACT_CONFIRMED", aggregate_type: "honor_case", aggregate_id: CASE, payload: { contribution_id: "c3", domain: "surgery", confirmed_by: "r" } },
    { event_id: "e5", occurred_at: T },
  );
  const held = receiveSigningReceipt(unfrozen, {
    receipt_id: "r1",
    honor_case_id: CASE,
    entries: eligibleEntries(unfrozen, CASE),
  });
  assert.equal(held.outcome, "held");
  assert.equal(held.event.payload.status, "CONSENT_NOT_FROZEN");
});

test("冻结同意版本时必须与授权记录版本一致", () => {
  const state = buildHappyCase({ consent: true });
  assert.throws(
    () =>
      commit(
        state,
        {
          event_type: "CONSENT_VERSION_FROZEN",
          aggregate_type: "honor_case",
          aggregate_id: CASE,
          payload: { consent_grant_id: "consent-1", consent_version: "v9", scope: {} },
        },
        { occurred_at: T },
      ),
    /版本不一致/,
  );
});

test("并发签署：相同回执重放、内容变化待核、一案只有一版生效", () => {
  const state = buildHappyCase();
  const entries = eligibleEntries(state, CASE);
  const receipt = { receipt_id: "r1", honor_case_id: CASE, entries };

  const first = receiveSigningReceipt(state, receipt);
  assert.equal(first.outcome, "effective");
  commit(state, first.event, { event_id: "sign1", occurred_at: T });

  // 完全相同的回执重放
  const replay_ = receiveSigningReceipt(state, receipt);
  assert.equal(replay_.outcome, "replay");

  // 内容变化（多一项）保留待核
  commit(state, attestDraft("c8", { domain: "anesthesia", name: "赵医生" }), { event_id: "e8", occurred_at: T });
  commit(
    state,
    { event_type: "FACT_CONFIRMED", aggregate_type: "honor_case", aggregate_id: CASE, payload: { contribution_id: "c8", domain: "anesthesia", confirmed_by: "麻醉代表" } },
    { event_id: "cf8", occurred_at: T },
  );
  const changed = receiveSigningReceipt(state, {
    receipt_id: "r1",
    honor_case_id: CASE,
    entries: eligibleEntries(state, CASE),
  });
  assert.equal(changed.outcome, "held");
  assert.equal(changed.event.payload.status, "CONTENT_CHANGED_PENDING_REVIEW");

  // 不同回执、不同内容同样不能再生效
  const other = receiveSigningReceipt(state, {
    receipt_id: "r2",
    honor_case_id: CASE,
    entries: eligibleEntries(state, CASE),
  });
  assert.equal(other.outcome, "held");
  assert.equal(other.event.payload.status, "ANOTHER_VERSION_EFFECTIVE_PENDING_REVIEW");

  // 生效名单快照仍只有原两项
  assert.deepEqual(state.rosters.get(CASE).effective.entry_ids, ["c1", "c2"]);
});

test("并发期间冒出异议会使签署内容失配而待核", () => {
  const state = buildHappyCase();
  const base = eligibleEntries(state, CASE);
  // 先记下签署内容，之后出现新异议
  commit(
    state,
    { event_type: "OBJECTION_FILED", aggregate_type: "honor_case", aggregate_id: CASE, payload: { objection_id: "ox", contribution_ids: ["c2"], reason: "新争议" } },
    { event_id: "ox", occurred_at: T },
  );
  const res = receiveSigningReceipt(state, { receipt_id: "r3", honor_case_id: CASE, entries: base });
  assert.equal(res.outcome, "held");
  assert.equal(res.event.payload.status, "STALE_VIEW_PENDING_REVIEW");
});

test("哈希错配的生效事件被直接拒绝（不能绕过待核）", () => {
  const state = buildHappyCase();
  assert.throws(
    () =>
      commit(
        state,
        {
          event_type: "ROSTER_EFFECTIVE",
          aggregate_type: "honor_roster",
          aggregate_id: `roster-${CASE}`,
          payload: {
            honor_case_id: CASE,
            receipt_id: "r9",
            content_hash: "0000000000000000000000000000000000000000000000000000000000000000",
            entry_ids: ["c1", "c2"],
          },
        },
        { occurred_at: T },
      ),
    /哈希/,
  );
});

test("同意撤回：历史不删除；未发布材料替换，已发布材料撤回；关联贡献暂停", () => {
  const state = buildHappyCase({ consent: true });
  // c3 的材料先发布
  commit(
    state,
    {
      event_type: "STORY_RELEASED",
      aggregate_type: "public_story",
      aggregate_id: "story-1",
      payload: {
        material_id: "mat-c3",
        contribution_id: "c3",
        consent_version: "v1",
        requires_consent: "consent-1",
        mask_refs: [{ material_id: "mat-c3" }],
      },
    },
    { event_id: "rel1", occurred_at: T },
  );
  const entries = eligibleEntries(state, CASE);
  const signing = receiveSigningReceipt(state, { receipt_id: "r1", honor_case_id: CASE, entries });
  commit(state, signing.event, { event_id: "sign1", occurred_at: T });

  const drafts = planConsentWithdrawal(state, { consent_grant_id: "consent-1", effective_scope: "all" });
  const types = drafts.map((d) => d.event_type);
  assert.ok(types.includes("CONSENT_WITHDRAWN"));
  assert.ok(types.includes("OBJECTION_FILED"));
  assert.ok(types.includes("MATERIAL_WITHDRAWN")); // 已发布 → 撤回
  assert.ok(types.includes("PUBLIC_NOTICE_PUBLISHED"));
  commitAll(state, drafts, { occurred_at: T });

  // 历史授权仍在
  assert.equal(state.consentGrants.get("consent-1").withdrawn, true);
  assert.ok(state.consentGrants.get("consent-1").history.some((h) => h.kind === "granted"));

  // 关联贡献被暂停，团队其余部分照常公开
  assert.ok(openDisputedIds(state, CASE).has("c3"));
  const pub = publicStatement(state, CASE);
  assert.deepEqual(
    pub.entries.map((e) => e.name).sort(),
    ["林护士", "王医生"],
  );
  assert.ok(pub.notices.some((n) => n.notice.includes("撤回")));
});

test("同意撤回时未发布材料走替换而非撤回", () => {
  const state = buildHappyCase({ consent: true });
  const drafts = planConsentWithdrawal(state, { consent_grant_id: "consent-1" });
  assert.ok(drafts.some((d) => d.event_type === "MATERIAL_REPLACED"));
  assert.ok(!drafts.some((d) => d.event_type === "MATERIAL_WITHDRAWN"));
});

test("资质更正：历史决议保留；未发布替换、已发布更正", () => {
  const state = buildHappyCase(); // mat-c1 未发布
  const drafts = planCredentialCorrection(state, {
    contribution_id: "c1",
    correction_id: "corr-1",
    reason: "执业证书编号录入错误",
    credential_at_time: { license: "S-FIXED-0001" },
  });
  const types = drafts.map((d) => d.event_type);
  assert.deepEqual(types, ["ATTRIBUTION_CORRECTED", "MATERIAL_REPLACED"]);
  commitAll(state, drafts, { occurred_at: T });

  // 历史确认仍在，且更正只追加
  assert.ok(state.contributions.get("c1").confirmed_by);
  assert.equal(state.contributions.get("c1").corrections[0].correction_id, "corr-1");
});

test("公开说明不暴露患者标识，内部档案保留完整事实", () => {
  const state = buildHappyCase({ consent: true });
  const signing = receiveSigningReceipt(state, {
    receipt_id: "r1",
    honor_case_id: CASE,
    entries: eligibleEntries(state, CASE),
  });
  commit(state, signing.event, { event_id: "sign1", occurred_at: T });

  const internal = internalCaseRecord(state, CASE);
  const found = internal.contributions.find((c) => c.contribution_id === "c3");
  assert.equal(found.work_fact.patient_id, "P-1");
  assert.ok(internal.frozen_consent);

  const pub = publicStatement(state, CASE);
  const publicResearch = pub.entries.find((e) => e.domain === "research");
  assert.equal(publicResearch.work_fact.patient_id, undefined);
  assert.equal(publicResearch.consent_version, "同意快照 v1");
});

test("授予理由可还原：为何授予、证据遮罩、后续处置", () => {
  const state = buildHappyCase({ consent: true });
  const signing = receiveSigningReceipt(state, {
    receipt_id: "r1",
    honor_case_id: CASE,
    entries: eligibleEntries(state, CASE),
  });
  commit(state, signing.event, { event_id: "sign1", occurred_at: T });

  // 撤回同意并撤回已发布材料
  commit(
    state,
    {
      event_type: "STORY_RELEASED",
      aggregate_type: "public_story",
      aggregate_id: "story-1",
      payload: {
        material_id: "mat-c3",
        contribution_id: "c3",
        consent_version: "v1",
        requires_consent: "consent-1",
        mask_refs: [{ material_id: "mat-c3" }],
      },
    },
    { event_id: "rel1", occurred_at: T },
  );
  commitAll(state, planConsentWithdrawal(state, { consent_grant_id: "consent-1" }), { occurred_at: T });

  const rationale = awardRationale(state, CASE);
  assert.equal(rationale.length, 3); // 生效快照三项都能追溯，含被暂停的 c3
  const r3 = rationale.find((r) => r.entry_id === "c3");
  assert.equal(r3.publication_status, "suspended_from_publication");
  assert.ok(r3.frozen_consent_snapshot);
  assert.ok(r3.later_dispositions.some((d) => d.kind === "withdrawn"));
  assert.equal(r3.awarded_because.patient_id, "P-1"); // 内部还原保留完整事实
});

test("样例事件流可以完整重放并产出五个生效条目", async () => {
  const events = JSON.parse(await readFile(new URL("../data/honor-case-sample.json", import.meta.url), "utf8"));
  const state = replay(events);
  const ids = eligibleEntries(state, "honor-2026-cardiac-team").map((e) => e.contribution_id);
  assert.deepEqual(ids, ["c-anesthesia-001", "c-nursing-001", "c-referral-001", "c-research-001", "c-surgery-001"]);

  // 两个张伟都在（未被自动合并），且同名提示已留痕
  const internal = internalCaseRecord(state, "honor-2026-cardiac-team");
  assert.ok(internal.name_suggestions[0].contribution_ids.includes("c-referral-001"));

  const pub = publicStatement(state, "honor-2026-cardiac-team");
  assert.equal(pub.published, true);
  assert.equal(pub.entries.length, 5);
  assert.equal(pub.entries.find((e) => e.domain === "research").consent_version, "同意快照 v1");

  // 生效名单哈希与事件一致，重放结果确定
  const hash = rosterContentHash(
    "honor-2026-cardiac-team",
    eligibleEntries(state, "honor-2026-cardiac-team"),
    internal.frozen_consent,
  );
  assert.equal(hash, state.rosters.get("honor-2026-cardiac-team").effective.content_hash);
});
