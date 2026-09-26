// 生成 data/honor-case-sample.json：一条完整的"合议 → 冻结同意 → 生效名单 → 发布"事件流。
// 运行：node scripts/build-sample.mjs
import { writeFile } from "node:fs/promises";

import { commit, emptyState, eligibleEntries, rosterContentHash } from "../src/honor-case.js";

const CASE_ID = "honor-2026-cardiac-team";
const NOW = "2026-09-22T09:00:00+08:00";
let tick = 0;
const at = () => new Date(Date.parse(NOW) + tick++ * 60_000).toISOString();

const state = emptyState();
const put = (draft, event_id, causation_id) =>
  commit(state, draft, { event_id, occurred_at: at(), causation_id });

// 1. 候选贡献：每条都必须指向具体工作事实、当时有效资质、可公开证据
const attest = (id, person, domain, work_fact, credential_at_time, public_evidence) =>
  put(
    {
      event_type: "CONTRIBUTION_ATTESTED",
      aggregate_type: "contribution_record",
      aggregate_id: id,
      payload: { honor_case_id: CASE_ID, person, domain, work_fact, credential_at_time, public_evidence },
    },
    `evt-attest-${id}`,
  );

attest(
  "c-surgery-001",
  { ref: "person-wang-zhudao", name: "王医生", role: "主刀" },
  "surgery",
  { description: "完成高难度冠脉旁路移植主刀操作", patient_id: "P-7788" },
  { license: "外科执业证 S-2019-0455", valid_from: "2019-05-01", valid_to: "2028-05-01" },
  [{ material_id: "e-opnote-001", requires_consent: null }, "手术记录公开摘要-2026-017"],
);
attest(
  "c-dup-001",
  { ref: "person-wang-zhudao", name: "王医生", role: "主刀" },
  "surgery",
  { description: "完成高难度冠脉旁路移植主刀操作", patient_id: "P-7788" },
  { license: "外科执业证 S-2019-0455", valid_from: "2019-05-01", valid_to: "2028-05-01" },
  [{ material_id: "e-opnote-dup", requires_consent: null }],
);
attest(
  "c-nursing-001",
  { ref: "person-lin-hushi", name: "林护士", role: "围术期护理" },
  "nursing",
  { description: "负责术后 72 小时监护与并发症预警处置" },
  { license: "护士执业证 N-2020-1188", valid_from: "2020-03-01", valid_to: "2027-03-01" },
  [{ material_id: "e-care-001", requires_consent: null }],
);
attest(
  "c-referral-001",
  { ref: "person-zhangwei-referral", name: "张伟", role: "基层转诊" },
  "referral",
  { description: "及时完成基层识别、影像初筛与上转衔接" },
  { license: "全科医师证 G-2018-0712", valid_from: "2018-09-01", valid_to: "2027-09-01" },
  [{ material_id: "e-referral-001", requires_consent: null }],
);
attest(
  "c-research-001",
  { ref: "person-zhangwei-research", name: "张伟", role: "研究数据支持" },
  "research",
  { description: "提供围术期随访数据集与统计分析", patient_id: "P-7788" },
  { license: "研究伦理备案 R-2025-033", valid_from: "2025-01-01", valid_to: "2027-01-01" },
  [{ material_id: "e-dataset-001", requires_consent: "consent-7788" }],
);
attest(
  "c-anesthesia-001",
  { ref: "person-zhao-mazui", name: "赵医生", role: "麻醉" },
  "anesthesia",
  { description: "制定并实施术中麻醉与循环管理方案" },
  { license: "麻醉执业证 A-2017-0066", valid_from: "2017-06-01", valid_to: "2028-06-01" },
  [{ material_id: "e-anesthesia-001", requires_consent: null }],
);

// 2. 同名提示：两个"张伟"来自转诊与研究系统，自动归并只能作为提示
put(
  {
    event_type: "NAME_MATCH_SUGGESTED",
    aggregate_type: "honor_case",
    aggregate_id: CASE_ID,
    payload: {
      contribution_ids: ["c-referral-001", "c-research-001"],
      reason: "姓名同为张伟但人员标识不同，仅提示，待委员会人工核实",
    },
  },
  "evt-name-match-001",
);

// 3. 各专业代表确认本领域事实
const confirm = (id, domain, rep) =>
  put(
    {
      event_type: "FACT_CONFIRMED",
      aggregate_type: "honor_case",
      aggregate_id: CASE_ID,
      payload: { contribution_id: id, domain, confirmed_by: rep },
    },
    `evt-confirm-${id}`,
  );
confirm("c-surgery-001", "surgery", "外科代表 孙主任");
confirm("c-nursing-001", "nursing", "护理代表 周护士长");
confirm("c-referral-001", "referral", "转诊代表 李科长");
confirm("c-research-001", "research", "研究代表 郑教授");

// 4. 委员会处理重叠：c-dup-001 并入 c-surgery-001
put(
  {
    event_type: "OVERLAP_RESOLVED",
    aggregate_type: "honor_case",
    aggregate_id: CASE_ID,
    payload: {
      contribution_ids: ["c-dup-001", "c-surgery-001"],
      decision: { kept: "c-surgery-001", note: "同一台手术的重复报送，并入主刀贡献" },
    },
  },
  "evt-overlap-001",
);

// 5. 委员会补充遗漏：麻醉协作者
put(
  {
    event_type: "OMISSION_ADDED",
    aggregate_type: "honor_case",
    aggregate_id: CASE_ID,
    payload: { contribution_id: "c-anesthesia-001", note: "初报名单遗漏麻醉，委员会依事实补入" },
  },
  "evt-omission-001",
);
confirm("c-anesthesia-001", "anesthesia", "麻醉代表 钱主任");

// 6. 患者授权并冻结当时同意版本
put(
  {
    event_type: "CONSENT_GRANTED",
    aggregate_type: "consent_grant",
    aggregate_id: "consent-7788",
    payload: {
      patient_id: "P-7788",
      consent_version: "v1",
      scope: { case_display: true, dataset_publication: true, deidentified_only: false },
    },
  },
  "evt-consent-granted-001",
);
put(
  {
    event_type: "CONSENT_VERSION_FROZEN",
    aggregate_type: "honor_case",
    aggregate_id: CASE_ID,
    payload: {
      consent_grant_id: "consent-7788",
      consent_version: "v1",
      scope: { case_display: true, dataset_publication: true, deidentified_only: false },
    },
  },
  "evt-consent-frozen-001",
);

// 7. 发布案例展示（发布时记录所用同意版本与遮罩）
put(
  {
    event_type: "STORY_RELEASED",
    aggregate_type: "public_story",
    aggregate_id: "story-7788",
    payload: {
      material_id: "e-dataset-001",
      contribution_id: "c-research-001",
      consent_version: "v1",
      requires_consent: "consent-7788",
      mask_refs: [{ material_id: "e-dataset-001" }],
    },
  },
  "evt-story-released-001",
);

// 8. 并发签署：内容由当前合议状态确定，形成唯一一版生效名单
const entries = eligibleEntries(state, CASE_ID);
const content_hash = rosterContentHash(CASE_ID, entries, state.cases.get(CASE_ID).frozenConsent);
put(
  {
    event_type: "ROSTER_EFFECTIVE",
    aggregate_type: "honor_roster",
    aggregate_id: `roster-${CASE_ID}`,
    payload: {
      honor_case_id: CASE_ID,
      receipt_id: "receipt-sign-2026-001",
      content_hash,
      entry_ids: entries.map((e) => e.contribution_id),
    },
  },
  "evt-roster-effective-001",
);

await writeFile(
  new URL("../data/honor-case-sample.json", import.meta.url),
  JSON.stringify(state.events, null, 2) + "\n",
  "utf8",
);
console.log(`已生成 ${state.events.length} 条事件；生效名单哈希 ${content_hash.slice(0, 12)}`);
