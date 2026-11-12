# 复核处理记录 · review-09 → 文档修订（第四轮，收尾）

> 2026-11-12 夜。Codex 第三轮最终复核：判定可开工 M0/G0，两处需补 + M2 归属一致性。全部处理完毕，附 20 项探针全绿结果。

## 处理总表

| # | 问题 | 处理 | 验证 |
|---|---|---|---|
| 1 verified 未强制冻结 | ✅ 已修 | format_rule 加 CHECK (verified = 0 OR frozen = 1)：「已验证必冻结」由数据库强制，验证动作必须在同一 UPDATE 中同时置 frozen=1 | 探针：INSERT verified=1&frozen=0 拦截；只置 verified=1 拦截；同语句置两值成功；随后改内容/改倍率均拦截；新增另一规则版本放行 |
| 2 探针失败仍退出码 0 | ✅ 已修 | ddl_probe.py 重写：每项对照预期计 pass/fail，任何非预期结果累加失败，失败即 sys.exit(1)，全过才打印 ALL PASS；SQL 改为**运行时从 docs/03 提取**（副本漂移即失败） | 自证：修复过程中一轮跑出 FAIL 时退出码=1；修复后 20 项全过、退出码=0 |
| 3 M2 归属一致性 | ✅ 已补 | docs/03：写入口不变量扩展到流水写入（batch.case_id=file.case_id；fund_flow 的 case_id/source_file_id 与批次绑定一致）；M2 验收补「错案/错文件/错批次三种拒绝写入探针」；M0 验收补 verified→frozen 探针 | 文档已闭合；实现探针随 M2 开发执行 |
| 4 source_unit 非法值可入库 | ✅ 顺手修 | source_unit 加 CHECK IN ('元','分') | 探针：'角' 拦截 |
| 5 docs/02 残留「去标识/待确认」旧文案 | ✅ 顺手修 | §二、§5.1 文案与用户「不脱敏」决定同步 | 已清理 |

## 全量探针结果（20 项，SQLite 3.45.1 内存库，foreign_keys=ON，SQL 运行时提取自 docs/03）

```text
PASS 0. DDL 原文建库
PASS unit配对 分+100 / source_unit非法值 / INSERT verified=1 frozen=0
PASS frozen UPDATE / frozen 解冻 / 置verified=1不同时frozen（均正确拦截）
PASS 未冻结UPDATE对照 / 验证动作同语句 / 新增另一规则版本（均符合预期）
PASS 验证冻结后再改内容 / 再改单位倍率（均正确拦截）
PASS 循环FK插入序列
PASS 规则版本错配 / 批内幂等 / 非法status / prev_flow_id不存在 / 同笔第二条余额结果（均正确拦截）
PASS 复合外键合法组合 / current指向failed(DB层允许→写入口检查)（均符合预期）
=== 探针总数 20，失败 0 === ALL PASS（退出码 0）
```

探针脚本：code/ddl_probe.py（运行时从 docs/03 提取 SQL，杜绝副本漂移）。

## 当前状态与开工边界

- 四份设计文档 + 九份审查记录，文档层面闭合；
- DDL 可直接建库、约束与触发器经 20 项探针验证；
- G0 前置（不脱敏）已由用户拍板；
- **可开工：M0 骨架 + G0 黄金样本并行**；M1 在 M0 探针全过后启动；M2 按里程碑补写入口一致性探针；
- 开工前唯一剩余动作：xlsx 解析库选型锁版本（docs/03 §三已列，属 M2 前置）。

