# G0 私有数据模板

把本目录的 `bundle.json`、`answers.jsonl` 复制到项目的 `golden-samples/g0/v1/` 再填充；该目录已被 Git 忽略。保留原件副本，记录哈希，不在这里填入真实账户或交易。

`bundle.json` 的三个数组分别装样本清单 `sources`、每格式规则卡 `rules`、待确认问题 `questions`。逐笔答案写入 `answers.jsonl`，一行一个 JSON 对象。完整字段以 [schema](../../../schemas/g0/bundle.schema.json) 为准，覆盖要求见 [41 项矩阵 v4](../../../schemas/g0/coverage-matrix.json)。

开始时可以保持空数组，运行：

```powershell
node scripts/g0/validate.cjs docs/g0/templates/bundle.json --json
```

空模板只会报告草稿结构可用、`ready_for_m1=false`。正式冻结前必须补齐实际原件、独立坐标索引、答案、规则批准、人工裁决与内容哈希，并用独立保存的清单哈希复核；详细步骤见 [交接与审核文档](../../09-G0验收契约与核对工具.md)。

已有纯合成完整示例由 `scripts/g0/checks/fixture.cjs` 在测试临时目录生成，用于检查工具。它的模拟真实角色和批准字段不是真实验收记录，不得直接复制为业务基准。

每张规则卡必填 `currency_map`，没有别名映射时填 `{}`。例如 `{"人民币":"CNY","156":"CNY"}` 只表示本格式的规则草稿，必须由该规则版本的 `review` 批准并写清依据后才能作为币种证据；示例不代表任何真实材料已经核实。原文仅在比较时 trim，按别名精确匹配，不改写原文，不允许空键或三字母 ISO 键，不能覆盖 USD 等已有证据。未命中或未批准时，非 ISO 币种保持 null、pending；缺原文仍仅允许已批准的 `verified_cny` 声明 CNY。

普通已批准映射行只挂 `amount_a` 等普通金额标签且无其他异常时仍可为 A 层；只有承担 `currency_mapped_cny` 等边界见证或有其他人工裁决条件的行才要求 B 层。规则卡应把映射表和批准依据单列一节，不将整列映射记录一律降为 B 层。

时间区间（含尾注）、负偏移含义不明、多义缩写或夹有文字才出现时间标记时，使用 `txn_time=null`、`status=pending`、`reason_code=time_ambiguous`，保留原文，不自动选起点／终点，也不贴 `time_timezone_marker` 来凑覆盖。明确时区标记后的括号、尾注不得令标记漏网；明确时区须时间未知、待核，原因含 time/timezone 且不是 `time_ambiguous`。第 41 项 `time_zone_abbreviation` 须原文实际命中名单内完整缩写，并核对最终分类对应原因；名单、边界反例及具体识别范围见 [最新交付说明](../../12-G0时间尾注与缩写识别修复.md)。

当前模板使用 `schema_version=3`、`matrix_version=4`。schema 中分别固定 `const: 3` 和 `const: 4`，旧结构 v1/v2 或矩阵 v1/v2/v3 均会被 SCHEMA 拒绝，不能为了兼容而放宽版本常量。采用 A 方案：本轮矩阵常量变化使 schema 内容变化，因此 schema 也另升新版本。升级须另存新数据集版本，补齐缩写见证、复核受影响规则及答案批准，重新固定 schema、矩阵、答案与 bundle 的哈希，保留旧基准。目录示例中的 `v1` 是样本自身版本，与契约／矩阵版本独立。
