const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary", "payload"];

// 事件类型与聚合的合法归属：事件只能发生在对应聚合上
const EVENT_AGGREGATE = {
  PROFILE_REGISTERED: ["nominee_profile"],
  CONTRIBUTION_ATTESTED: ["contribution_record"],
  CONSENT_GRANTED: ["consent_grant"],
  CONSENT_WITHDRAWN: ["consent_grant"],
  STORY_RELEASED: ["public_story"],
  ATTRIBUTION_CORRECTED: ["contribution_record"],
  NAME_MATCH_SUGGESTED: ["honor_case"],
  FACT_CONFIRMED: ["honor_case"],
  OVERLAP_RESOLVED: ["honor_case"],
  OMISSION_ADDED: ["honor_case"],
  OBJECTION_FILED: ["honor_case"],
  OBJECTION_RESOLVED: ["honor_case"],
  CONSENT_VERSION_FROZEN: ["honor_case"],
  ROSTER_SIGNING_HELD: ["honor_roster"],
  ROSTER_EFFECTIVE: ["honor_roster"],
  MATERIAL_REPLACED: ["contribution_record"],
  MATERIAL_CORRECTED: ["public_story"],
  MATERIAL_WITHDRAWN: ["public_story"],
  PUBLIC_NOTICE_PUBLISHED: ["honor_roster"],
};

// 各事件类型必须在 payload 中出现的字段
const PAYLOAD_REQUIRED = {
  CONTRIBUTION_ATTESTED: ["honor_case_id", "domain", "work_fact", "credential_at_time", "public_evidence"],
  NAME_MATCH_SUGGESTED: ["contribution_ids"],
  FACT_CONFIRMED: ["contribution_id", "domain", "confirmed_by"],
  OVERLAP_RESOLVED: ["contribution_ids", "decision"],
  OMISSION_ADDED: ["contribution_id"],
  OBJECTION_FILED: ["objection_id", "contribution_ids", "reason"],
  OBJECTION_RESOLVED: ["objection_id", "decision"],
  CONSENT_VERSION_FROZEN: ["consent_grant_id", "consent_version", "scope"],
  CONSENT_GRANTED: ["patient_id", "consent_version", "scope"],
  CONSENT_WITHDRAWN: ["patient_id", "effective_scope"],
  ROSTER_SIGNING_HELD: ["honor_case_id", "receipt_id", "content_hash", "status"],
  ROSTER_EFFECTIVE: ["honor_case_id", "receipt_id", "content_hash", "entry_ids"],
  MATERIAL_REPLACED: ["material_id", "reason", "mask_refs"],
  MATERIAL_CORRECTED: ["material_id", "reason", "mask_refs"],
  MATERIAL_WITHDRAWN: ["material_id", "reason", "mask_refs"],
  ATTRIBUTION_CORRECTED: ["correction_id", "reason"],
  STORY_RELEASED: ["material_id", "consent_version", "mask_refs"],
  PUBLIC_NOTICE_PUBLISHED: ["honor_case_id", "notice"],
};

export function validateEvent(record) {
  const errors = required
    .filter((name) => !(name in record))
    .map((name) => `缺少字段：${name}`);

  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }

  const allowedAggregates = EVENT_AGGREGATE[record.event_type];
  if (allowedAggregates && !allowedAggregates.includes(record.aggregate_type)) {
    errors.push(`事件 ${record.event_type} 不能挂在聚合 ${record.aggregate_type} 上`);
  }

  const payloadFields = PAYLOAD_REQUIRED[record.event_type];
  if (payloadFields) {
    const payload = record.payload ?? {};
    for (const field of payloadFields) {
      if (!(field in payload)) errors.push(`事件 ${record.event_type} 的 payload 缺少字段：${field}`);
    }
  }

  // 候选贡献三要素锚点：不允许为空串或空数组
  if (record.event_type === "CONTRIBUTION_ATTESTED" && record.payload) {
    for (const anchor of ["work_fact", "credential_at_time", "public_evidence"]) {
      const value = record.payload[anchor];
      const empty = value === undefined || value === null || value === "" ||
        (Array.isArray(value) && value.length === 0);
      if (empty) errors.push(`候选贡献的 ${anchor} 必须指向具体内容，不能为空`);
    }
  }

  return errors;
}

export { EVENT_AGGREGATE, PAYLOAD_REQUIRED };
