# 独立样本结构盘点

`inventory.py` 只使用 Python 标准库，按私有选择清单读取原件或 ZIP/TAR 中的明确成员，输出字节相同的私有副本、哈希与原始坐标索引。不调用产品解析器、金额引擎或G0校验器，不产生业务标准答案。

在项目根目录运行（将示例路径换成已批准的私有位置）：

```text
python scripts/samples/inventory.py --manifest golden-samples/<dataset>/selection.json --out golden-samples/<dataset>
```

选择清单须含 `dataset_id`、`date`、`sources`。每份source包含无身份信息的`id`、`case_ref`、`role`、`format`和原件`path`；归档成员用按顺序的`members: [{container: "zip"|"tar", name: "exact-member-name"}]`；CSV/TXT额外指定严格`encoding`和单字符`delimiter`。`inspect`按1起始`position`与`kind`选择time/identity/amount/currency/direction/state/business_type等列。XLSX通过`sheets`指定交易sheet与非交易sheet，通过`inspect_sheets`指定观察列。

输出包括`inventory.json`、`sources/<id>.<ext>`与`indexes/<id>.jsonl`。索引行仅包含`source_loc`与`kind`：TXT/CSV为包含表头的逻辑记录号，XLSX为`sheet!原始行号`。相同SHA256文件另列重复组。程序拒绝覆盖已有不同内容的副本，读取原始文件前后检查大小/修改时间；原件路径只读。

数据分类是**结构候选**：非空同宽CSV记录、指定交易sheet内非空存储行；未定业务含义、账号身份、尾注或合计仍需规则卡与人工审查。日期只观察文本边界；十进制只观察语法，不经过浮点或业务改向。非交易sheet不产生资金流水。XLSX值按XML存储类型观察，不把数值字串转成float；无法恢复原文件既有精度损失。

物理行只按CRLF/LF/CR计数，记录边界由CSV读取器决定。字段中的换页符等控制字符保留并单列观察，禁止用`splitlines()`替代CSV逻辑记录读取。无BOM仅是观察，不作为自动编码猜测依据。

选择清单、原件副本、真实路径与身份、逐行答案均留在Git忽略的`golden-samples/`，公开仓库只提交此通用脚本与说明。该输出不是完整G0 bundle，不能宣称G0完成或已有已批准业务规则。

## 独立账户CSV答案草稿

`oracle-alipay.py` 使用 Python csv/Decimal/datetime 独立生成一个已固定文件身份的子集答案，不调用产品金额或解析模块。示例：

```text
python scripts/samples/oracle-alipay.py --source PRIVATE.csv --rule PRIVATE-draft-rule.json --out NEW-PRIVATE-DIRECTORY
```

默认只接受 draft 配置。需显式固定来源哈希、17列表头和列位、单位、方向与时间政策；币种和复合身份另有证据字段。生成的逐行 review 均未批准，不冻结、不产生完整G0的ready结论。`--approved-rule` 仅接受实际提供的完整批准记录，不是自动审批开关；真实规则需先经过用户与审核流程。

输出包含 `answers.jsonl` 和 `report.json`，固定生成器/规则/原件/答案SHA256。目标目录不得已有答案，规则改变另出版本，不覆盖历史文件。完整原字段和身份仍仅保存在私有目录。
