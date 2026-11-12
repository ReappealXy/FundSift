# 复核处理记录 · review-05 → 文档修订（第二轮）

> 2026-11-12 晚。Codex 复核判定「尚未通过」，列 F01~F09。本记录逐项登记处理结果与落点。

## 处理总表

| # | 问题 | 处理 | 落点 |
|---|---|---|---|
| F01 单位倍率错置（会缩小 100 倍） | ✅ 已修 | docs/02 §3.1/§4.3：入库倍率唯一规则「元→分=100；分→分=1」，微信 $/100 明确为外部模板显示变换、非入库倍率；docs/03 DDL：unit_scale INTEGER CHECK IN (1,100)，新增 source_unit 列（原单位落表位置） |
| F02 余额公式反例与状态解耦 | ✅ 已修 | docs/02 §4.5：公式限域「仅 asset_ledger 且格式规则确认同向」；balance_scope 四类；Codex 的金额/余额状态边界表原文收录；待核行呈现规则（不混入、披露无法量化记录数）；docs/03 DDL：balance_check 每笔唯一 + prev_flow_id 外键 |
| F03 再导协议不闭合 | ✅ 已修 | docs/03 §4.1：三职责分离（source_file 原件身份唯一 / import_batch 每次解析运行 / current_batch_id 有效指针）；再导失败指针不动、旧结果有效；统计口径唯一定义；DDL 加 UNIQUE(batch_id, source_file_id, source_loc) 批内幂等 |
| F04 规则追溯与约束不完整 | ✅ 已修 | docs/03 DDL：source_file.format_rule_id 外键、balance_check.prev_flow_id 外键、fund_flow (format_rule_id, rule_version) 复合外键 + format_rule UNIQUE(id, rule_version) + frozen 不可变版本、status 全表 CHECK 枚举、parser_version 入批次 |
| F05 冲突表误拦正常数据/双列负数/方向词映射 | ✅ 已修 | docs/02 §4.1：判定顺序固定（格式识别→词表映射→冲突表→F 兜底）；「两列皆有值」改为「两列均为非零数值」（收入100/支出0 正常）；D 类负值路径明确；F 兜底语义写明（文件级+行级两个出口） |
| F06 验收矩阵不固定 | ✅ 已修 | docs/02 §5.1 覆盖矩阵（冲突表每行 + 每种 balance_scope 都有合成用例）；docs/03 M4 导出边界用例（1,048,574/575/576 + 235 万合成）；内存口径明确为 worker 峰值 RSS；回源抽查样本量（≥200 随机 + 全部异常行）；耗时明确为基线记录项不设阈值；界面不冻结用 <200ms 交互观测 |
| F07 总览旧承诺未同步 | ✅ 已修 | docs/01：删「千万行无忧」；worker 分工表述；删「表与规则 SQL 不改」，明确第 4 片需适配并逐规则复验；「1:1 对齐」改为「参考对齐」 |
| F08 规模口径混用原始定义与单位 | ✅ 已修 | docs/01 §2.4 与 docs/03 §二统一采用 review-05 实测表（106/42/4515/1077/826/228/333 文件，MiB/GiB 标注）；注明「排除 .workbuddy 后仍含加工件」与快照日期 |
| F09 脱敏方案待用户确认 | ⏳ 待用户 | docs/02 §5.2 已细化：摘要/备注/文件名/sheet 名须一并检查；账号用一致且不合并的别名映射；四项待确认清单（字段/位置/Git/人员）——执行 G0 前需用户逐项拍板 |

## 遗留项

1. F09 脱敏方案：等待用户确认（不阻塞 M0 骨架与库无关准备）；
2. M2/M4 的量化验收（RSS <1GB、<200ms、导出边界）已写入计划，尚待开发实测；
3. xlsx 解析库选型与锁版本：开工前完成（docs/03 §三已列前置条件）。

## 给复检的提示

- F03 的语义已写死为「保留转换历史 + 指针切换」，请重点验证 DDL 中 current_batch_id 与 UNIQUE(batch_id, source_file_id, source_loc) 的组合是否仍有漏洞；
- fund_flow 复合外键要求 format_rule 有 UNIQUE(id, rule_version)，已加；请复核 SQLite 对复合 FK 的接受情况（建议仍以内存库探针验证）。

