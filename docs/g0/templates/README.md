# G0 私有数据模板

把本目录的 `bundle.json`、`answers.jsonl` 复制到项目的 `golden-samples/g0/v1/` 再填充；该目录已被 Git 忽略。保留原件副本，记录哈希，不在这里填入真实账户或交易。

`bundle.json` 的三个数组分别装样本清单 `sources`、每格式规则卡 `rules`、待确认问题 `questions`。逐笔答案写入 `answers.jsonl`，一行一个 JSON 对象。完整字段以 [schema](../../../schemas/g0/bundle.schema.json) 为准，覆盖要求见 [38 项矩阵 v2](../../../schemas/g0/coverage-matrix.json)。

开始时可以保持空数组，运行：

```powershell
node scripts/g0/validate.cjs docs/g0/templates/bundle.json --json
```

空模板只会报告草稿结构可用、`ready_for_m1=false`。正式冻结前必须补齐实际原件、独立坐标索引、答案、规则批准、人工裁决与内容哈希，并用独立保存的清单哈希复核；详细步骤见 [交接与审核文档](../../09-G0验收契约与核对工具.md)。

已有纯合成完整示例由 `scripts/g0/checks/fixture.cjs` 在测试临时目录生成，用于检查工具。它的模拟真实角色和批准字段不是真实验收记录，不得直接复制为业务基准。

当前模板使用 `schema_version=1`、`matrix_version=2`。已有 v1 清单不会被自动放行：须另存新数据集版本，补齐带时区时间与不可解析金额两个见证，重新核对并固定 schema、矩阵、答案与 bundle 的哈希，保留旧基准。
