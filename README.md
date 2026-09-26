# 医者荣誉贡献档案

本仓库保存该服务的领域资料与事件约定，围绕**团队荣誉发布前的贡献合议、发布冻结与档案还原**建设。

## 业务规则（与院务办公室要求一一对应）

1. **候选贡献三要素**：`CONTRIBUTION_ATTESTED` 必须携带
   - `work_fact`：具体工作事实（做了什么、哪台手术/哪份数据）；
   - `credential_at_time`：当时有效的资质（证书与有效期）；
   - `public_evidence`：可公开证据（材料标识，可标注是否需要患者同意）。
   任一为空即被拒绝。
2. **同名只提示**：跨系统同名人员产生 `NAME_MATCH_SUGGESTED`，系统**不自动归并**，由委员会人工裁定。
3. **分级合议**：各专业代表只能用 `FACT_CONFIRMED` 确认**本领域**事实（跨域确认被拒绝）；荣誉委员会用 `OVERLAP_RESOLVED`（重叠归并/份额）、`OMISSION_ADDED`（补遗漏）、`OBJECTION_FILED/RESOLVED`（异议）处理争议。
4. **异议隔离**：异议期间仅争议贡献退出可发布集合（`eligibleEntries` 过滤 `open_objections`），团队其余部分不受阻断。
5. **同意版本冻结**：涉及患者案例的材料（`requires_consent`）在名单签署前必须先有 `CONSENT_VERSION_FROZEN`，冻结的是当时授权版本与展示范围快照；未冻结时签署回执被置为 `ROSTER_SIGNING_HELD`（原因 `CONSENT_NOT_FROZEN`)。
6. **历史不可删除，更正只追加**：资质更正（`ATTRIBUTION_CORRECTED`）与同意撤回（`CONSENT_WITHDRAWN`）都不删除既往确认、决议和授权历史。
7. **材料分级处置**：
   - 资质更正：未发布材料 `MATERIAL_REPLACED`（发布前替换）；已发布材料 `MATERIAL_CORRECTED`（更正并遮罩旧证据），必要时附 `PUBLIC_NOTICE_PUBLISHED` 更正说明。
   - 同意撤回：未发布材料以去标识化版本 `MATERIAL_REPLACED`；已发布材料 `MATERIAL_WITHDRAWN` 并发布撤回公告。撤回自动对关联贡献提出异议（暂停争议项，不波及团队其余部分）。
8. **并发签署只出一版生效名单**：
   - 名单内容哈希（`rosterContentHash`，SHA-256）覆盖案件、有序条目与冻结同意版本；
   - 完全相同的回执 → 幂等重放（`replay`）；
   - 同回执内容变化、他版已生效、或回执视图滞后（签署期间冒出异议）→ 记 `ROSTER_SIGNING_HELD` 并给出状态码（`CONTENT_CHANGED_PENDING_REVIEW` 等），**保留待核**，绝不再生效第二版；
   - 直接提交哈希失配的 `ROSTER_EFFECTIVE` 会被拒绝。
9. **内外部档案分离**：
   - `internalCaseRecord`：完整事实（含患者标识、资质、异议全过程、处置轨迹）；
   - `publicStatement`：仅生效且未暂停的条目，剔除患者标识，标注证据可见/遮罩/撤回状态与同意快照版本；
   - `awardRationale`：还原每项荣誉**为何授予、由谁确认事实、委员会如何审查、使用了哪个同意快照、哪些证据被遮罩、后来如何处置**。

## 文件结构

- `contracts/domain.schema.json`：领域事件、聚合类型与 payload 必填约定。
- `src/validator.js`：事件信封、事件↔聚合归属、三要素锚点校验。
- `src/honor-case.js`：事件重放归约器、合议/异议/同意冻结/材料处置决策、签署幂等、内外部投影。
- `scripts/build-sample.mjs`：生成确定性样例事件流。
- `data/sample.json`：基础信封样例；`data/honor-case-sample.json`：完整业务样例（主刀、护理、转诊、研究、麻醉补遗；两个"张伟"仅提示；同意 v1 冻结后发布）。
- `tests/`：契约测试 + 20 个业务场景测试。

## 本地检查

```bash
npm test          # 全部测试
npm run build     # 语法检查
npm run build:sample   # 重新生成样例事件流
```

## 领域边界

当前资料围绕团队贡献、资质核验和患者同意整理。事件一旦被接收，其标识、发生时间和版本不应被原地改写；业务更正产生后继记录（更正/撤回/替换/更正公告）。涉及个人、机构或商业敏感信息时，调用方只读取完成职责所必需的字段；对外展示一律经 `publicStatement` 投影，不直接暴露内部事件。

这些命令可在单个 Linux 应用容器内执行，不需要另行启动外部服务。
