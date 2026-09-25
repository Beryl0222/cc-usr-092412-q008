import assert from "node:assert/strict";
import test from "node:test";

import { HonorAdjudicationService, replay } from "../src/adjudication.js";

let clockMs = 0;
function clock() {
  clockMs += 1;
  return new Date(Date.parse("2026-09-21T09:00:00+08:00") + clockMs * 1000).toISOString();
}

function newService() {
  clockMs = 0;
  const svc = new HonorAdjudicationService({ clock });
  svc.openCase({ caseId: "honor-2026-team-a", title: "2026 年度跨系统诊疗团队荣誉" });
  return svc;
}

const QUAL = {
  qualificationId: "q-surg-01",
  title: "主刀医师执业资质",
  valid_from: "2020-01-01T00:00:00+08:00",
  valid_to: null,
};

function contrib(id, overrides = {}) {
  return {
    contributionId: id,
    person: { personId: `p-${id}`, name: overrides.name ?? `人员${id}` },
    specialty: overrides.specialty ?? "surgery",
    workFact: {
      description: overrides.fact ?? `完成 ${id} 的关键诊疗工作`,
      occurred_on: "2026-03-10T10:00:00+08:00",
    },
    qualification: overrides.qualification ?? QUAL,
    evidence: overrides.evidence ?? {
      evidenceId: `ev-${id}`,
      kind: "operative_record",
      public_ref: `https://example.org/evidence/${id}`,
    },
  };
}

test("候选贡献必须具备工作事实、当时有效资质与可公开证据", () => {
  const svc = newService();

  assert.throws(
    () => svc.nominateContribution(contrib("c1", { fact: "  " })),
    /工作事实/,
  );
  assert.throws(
    () => svc.nominateContribution(contrib("c1", {
      qualification: { qualificationId: "q-expired", valid_from: "2030-01-01T00:00:00+08:00", valid_to: null },
    })),
    /资质在工作事实发生时不在有效期内/,
  );
  assert.throws(
    () => svc.nominateContribution(contrib("c1", {
      evidence: { evidenceId: "ev-x", kind: "note" },
    })),
    /可公开定位/,
  );
  // 涉及患者案例必须声明展示范围
  assert.throws(
    () => svc.nominateContribution(contrib("c1", {
      evidence: { evidenceId: "ev-x", kind: "case", public_ref: "ref/x", patient_case_id: "case-9" },
    })),
    /展示范围/,
  );

  svc.nominateContribution(contrib("c1"));
  assert.equal(svc.getEffectiveRoster(), null);
  assert.equal(svc.events.length, 2); // 建案 + 提名
});

test("同名人员只产生归并提示，不自动合并身份", () => {
  const svc = newService();
  svc.nominateContribution(contrib("c1", { name: "李华" }));
  svc.nominateContribution(contrib("c2", { name: "李华" })); // 同名不同 personId
  svc.nominateContribution(contrib("c3", { name: "王芳" }));

  const hints = svc.getSameNameHints();
  assert.equal(hints.length, 1);
  assert.deepEqual(hints[0].contributionIds, ["c1", "c2"]);
  // 两条贡献仍是独立人员
  const archive = svc.buildArchive.bind(svc);
  void archive;
});

test("专业代表只能确认本专业事实", () => {
  const svc = newService();
  svc.nominateContribution(contrib("c1", { specialty: "surgery" }));
  svc.nominateContribution(contrib("c2", { specialty: "nursing" }));

  assert.throws(
    () => svc.confirmFacts({ repId: "rep-nurse", specialties: ["nursing"], contributionIds: ["c1"] }),
    /只能确认本专业/,
  );
  svc.confirmFacts({ repId: "rep-nurse", specialties: ["nursing"], contributionIds: ["c2"] });
  svc.confirmFacts({ repId: "rep-surg", specialties: ["surgery"], contributionIds: ["c1"] });
});

test("异议期间只暂停争议贡献，不阻断无关联团队部分", () => {
  const svc = newService();
  svc.nominateContribution(contrib("c1", { specialty: "surgery" }));
  svc.nominateContribution(contrib("c2", { specialty: "nursing" }));
  svc.confirmFacts({ repId: "rep-surg", specialties: ["surgery"], contributionIds: ["c1"] });
  svc.confirmFacts({ repId: "rep-nurse", specialties: ["nursing"], contributionIds: ["c2"] });

  svc.fileDispute({ disputeId: "d1", contributionId: "c1", reason: "主刀排名存疑" });
  assert.deepEqual(svc.getPausedContributions(), ["c1"]);

  // 签署包含两条：争议条目被暂停排除，护理条目照常生效
  const result = svc.signRoster({
    receiptId: "rcpt-1", expectedVersion: svc.version(), signer: "office",
    entries: [{ contribution_id: "c1" }, { contribution_id: "c2" }],
  });
  assert.deepEqual(result.roster.entries, ["c2"]);
  assert.equal(result.excluded[0].contribution_id, "c1");
  assert.equal(result.excluded[0].reason, "disputed_paused");

  // 异议裁决维持：c1 恢复确认后进入新版本名单
  svc.resolveDispute({ disputeId: "d1", contributionId: "c1", decision: "uphold", rationale: "手术记录支持排名" });
  const result2 = svc.signRoster({
    receiptId: "rcpt-2", expectedVersion: svc.version(), signer: "office",
    entries: [{ contribution_id: "c1" }, { contribution_id: "c2" }],
  });
  assert.deepEqual(result2.roster.entries, ["c1", "c2"]);
});

test("患者案例展示范围冻结当时同意版本；撤回后遮罩证据且不删历史", () => {
  const svc = newService();
  svc.nominateContribution(contrib("c1", {
    evidence: {
      evidenceId: "ev-case", kind: "patient_case", public_ref: "ref/case-9",
      patient_case_id: "case-9", requires_scope: ["story_text", "anonymized_image"],
    },
  }));
  svc.confirmFacts({ repId: "rep-surg", specialties: ["surgery"], contributionIds: ["c1"] });
  svc.grantConsent({
    grantId: "g1", patientCaseId: "case-9", versionId: "consent-v1",
    scope: ["story_text", "anonymized_image"], grantedAt: "2026-02-01T00:00:00+08:00",
  });

  // 未冻结同意版本前不能进入生效名单
  let result = svc.signRoster({
    receiptId: "rcpt-x", expectedVersion: svc.version(), signer: "office", entries: ["c1"],
  });
  assert.equal(result.excluded[0].reason, "consent_version_not_frozen");

  svc.freezeConsentVersion({ grantId: "g1" });
  result = svc.signRoster({
    receiptId: "rcpt-1", expectedVersion: svc.version(), signer: "office", entries: ["c1"],
  });
  assert.deepEqual(result.roster.entries, ["c1"]);

  // 发布后患者撤回同意：证据遮罩、历史决议仍在、已发布材料必须更正或撤回
  svc.draftMaterial({ materialId: "m1", contributionId: "c1", includesPatientCase: true });
  svc.publishMaterials({ materialIds: ["m1"] });
  svc.withdrawConsent({ grantId: "g1" });

  const archive = svc.buildArchive();
  const internal = archive.internal.contributions.find((c) => c.contribution_id === "c1");
  assert.ok(internal.evidence.masked, "证据应被遮罩");
  // 生效名单的历史事实没有被删除
  assert.deepEqual(archive.internal.roster.entries, ["c1"]);
  // 公开说明不再给出案例证据引用
  assert.deepEqual(archive.public.honorees[0].evidence_refs, []);

  const material = archive.internal.materials.find((m) => m.material_id === "m1");
  assert.equal(material.pending_effects.length, 1);
  assert.throws(() => svc.disposeMaterial({ materialId: "m1", action: "replace", reason: "x" }), /已发布/);
  svc.disposeMaterial({ materialId: "m1", action: "retract", reason: "患者撤回公开案例同意" });
});

test("资质更正保留历史链路；未发布材料替换、已发布材料更正", () => {
  const svc = newService();
  svc.nominateContribution(contrib("c1"));
  svc.confirmFacts({ repId: "rep-surg", specialties: ["surgery"], contributionIds: ["c1"] });

  // 未发布草稿
  svc.draftMaterial({ materialId: "m-draft", contributionId: "c1" });

  svc.signRoster({
    receiptId: "rcpt-1", expectedVersion: svc.version(), signer: "office", entries: ["c1"],
  });
  svc.draftMaterial({ materialId: "m-pub", contributionId: "c1" });
  svc.publishMaterials({ materialIds: ["m-pub"] });

  svc.correctQualification({
    contributionId: "c1",
    qualification: { qualificationId: "q-surg-02", title: "更正后的资质编号", valid_from: "2019-06-01T00:00:00+08:00", valid_to: null },
  });

  const archiveBefore = svc.buildArchive();
  const c = archiveBefore.internal.contributions[0];
  assert.equal(c.qualification_corrections.length, 1, "历史资质必须保留");
  assert.equal(c.granted_because.qualification_effective_at_fact.qualificationId, "q-surg-01");

  assert.throws(() => svc.disposeMaterial({ materialId: "m-pub", action: "replace", reason: "x" }), /尚未发布|已发布/);
  svc.disposeMaterial({ materialId: "m-draft", action: "replace", reason: "按更正资质更新未发布材料" });
  svc.disposeMaterial({ materialId: "m-pub", action: "correct", reason: "按更正资质发布更正说明" });

  const archive = svc.buildArchive();
  const mats = Object.fromEntries(archive.internal.materials.map((m) => [m.material_id, m]));
  assert.equal(mats["m-draft"].status, "replaced");
  assert.equal(mats["m-pub"].status, "published_corrected");
});

test("并发签署：相同回执可重放，内容变化只形成一版生效名单并保留待核", () => {
  const svc = newService();
  svc.nominateContribution(contrib("c1"));
  svc.nominateContribution(contrib("c2", { specialty: "nursing" }));
  svc.confirmFacts({ repId: "rep-surg", specialties: ["surgery"], contributionIds: ["c1"] });
  svc.confirmFacts({ repId: "rep-nurse", specialties: ["nursing"], contributionIds: ["c2"] });

  const versionAtSign = svc.version();
  // 请求 A 先签署成功
  const a = svc.signRoster({ receiptId: "rcpt-A", expectedVersion: versionAtSign, signer: "A", entries: ["c1", "c2"] });
  assert.equal(a.roster.version, 1);

  // 完全相同的回执重放：不新增事件
  const eventsBefore = svc.events.length;
  const replayResult = svc.signRoster({ receiptId: "rcpt-A", expectedVersion: versionAtSign, signer: "A", entries: ["c2", "c1"] });
  assert.equal(replayResult.replayed, true);
  assert.equal(svc.events.length, eventsBefore);

  // 请求 B 基于旧版本、内容不同：保留待核而非直接生效
  const b = svc.signRoster({ receiptId: "rcpt-B", expectedVersion: versionAtSign, signer: "B", entries: ["c1"] });
  assert.ok(b.held, "内容变化的并发签署应保留待核");
  assert.equal(svc.getEffectiveRoster().version, 1, "仍只有一版生效名单");

  // 同回执再次提交且内容又变：继续待核
  const b2 = svc.signRoster({ receiptId: "rcpt-B", expectedVersion: versionAtSign, signer: "B", entries: ["c2"] });
  assert.ok(b2.held);

  // 委员会复核通过后才形成新版本
  svc.resolveHeldSigning({ heldId: b.held.heldId, decision: "accept", rationale: "与 A 版本互补，复核通过", signer: "committee" });
  assert.equal(svc.getEffectiveRoster().version, 2);
  assert.deepEqual(svc.getEffectiveRoster().entries, ["c1"]);
});

test("委员会处理重叠与遗漏", () => {
  const svc = newService();
  svc.nominateContribution(contrib("c1"));
  svc.nominateContribution(contrib("c2", { specialty: "research" }));
  svc.confirmFacts({ repId: "rep-surg", specialties: ["surgery"], contributionIds: ["c1"] });
  svc.confirmFacts({ repId: "rep-res", specialties: ["research"], contributionIds: ["c2"] });

  svc.flagOverlap({ factId: "fact-1", contributionIds: ["c1", "c2"], reason: "同一台手术的记录重复申报" });
  svc.resolveOverlap({ factId: "fact-1", include: ["c1"], exclude: ["c2"], rationale: "研究支持已在另一事实中体现" });

  svc.flagOmission({ omissionId: "om-1", description: "转诊来源的基层医生未被提名" });
  svc.nominateContribution(contrib("c3", { specialty: "referral", name: "赵转诊" }));
  svc.confirmFacts({ repId: "rep-ref", specialties: ["referral"], contributionIds: ["c3"] });
  svc.resolveOmission({ omissionId: "om-1", action: "add_contribution", contributionId: "c3", rationale: "转诊记录证实关键协作" });

  const result = svc.signRoster({
    receiptId: "rcpt-1", expectedVersion: svc.version(), signer: "office", entries: ["c1", "c2", "c3"],
  });
  assert.deepEqual(result.roster.entries, ["c1", "c3"]);
  assert.equal(result.excluded.find((x) => x.contribution_id === "c2").reason, "excluded_by_overlap");
});

test("封存档案可还原授予理由、遮罩证据与后续处置，且内部/公开分离", () => {
  const svc = newService();
  svc.nominateContribution(contrib("c1"));
  svc.confirmFacts({ repId: "rep-surg", specialties: ["surgery"], contributionIds: ["c1"] });
  svc.signRoster({ receiptId: "rcpt-1", expectedVersion: svc.version(), signer: "office", entries: ["c1"] });
  svc.draftMaterial({ materialId: "m1", contributionId: "c1" });
  svc.publishMaterials({ materialIds: ["m1"] });
  svc.correctQualification({
    contributionId: "c1",
    qualification: { qualificationId: "q-fix", valid_from: "2019-01-01T00:00:00+08:00", valid_to: null },
  });
  svc.disposeMaterial({ materialId: "m1", action: "correct", reason: "资质编号更正" });

  const { archive } = svc.sealArchive();
  // 为何授予：工作事实、当时资质、专业确认
  const c = archive.internal.contributions[0];
  assert.match(c.granted_because.work_fact.description, /c1/);
  assert.equal(c.granted_because.qualification_effective_at_fact.qualificationId, "q-surg-01");
  assert.equal(c.granted_because.confirmed_by.length, 1);
  // 后续处置可追溯
  assert.equal(archive.internal.materials[0].dispositions[0].action, "correct");
  // 公开说明不含内部资质编号、争议等字段
  const publicKeys = Object.keys(archive.public.honorees[0]).sort();
  assert.deepEqual(publicKeys, ["contribution_summary", "evidence_refs", "name", "public_notices", "specialty"]);
  assert.ok(archive.sealed_at);
});

test("事件重放得到相同状态（历史决议不可变）", () => {
  const svc = newService();
  svc.nominateContribution(contrib("c1", { name: "李华" }));
  svc.nominateContribution(contrib("c2", { name: "李华", specialty: "nursing" }));
  svc.confirmFacts({ repId: "rep-surg", specialties: ["surgery"], contributionIds: ["c1"] });
  svc.fileDispute({ disputeId: "d1", contributionId: "c1", reason: "存疑" });
  svc.resolveDispute({ disputeId: "d1", contributionId: "c1", decision: "remove", rationale: "事实不足" });
  svc.confirmFacts({ repId: "rep-nurse", specialties: ["nursing"], contributionIds: ["c2"] });
  svc.signRoster({ receiptId: "rcpt-1", expectedVersion: svc.version(), signer: "office", entries: ["c1", "c2"] });

  const restored = replay(svc.events);
  assert.equal(restored.contributions.get("c1").status, "removed");
  assert.deepEqual(restored.effectiveRoster.entries, ["c2"]);
  assert.equal(restored.hints.length, 1);
  // 被移除的贡献记录仍然存在于历史中
  assert.ok(restored.contributions.has("c1"));
});
