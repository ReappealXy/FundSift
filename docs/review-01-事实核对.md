# 核对报告 · docs/02-金额符号处理规则.md「金额符号处理」断言 vs 逆向资料

- 核对对象：docs/02-金额符号处理规则.md 第 25–45 行（「三、逆向资料中的既有处理」）断言 A–G
- 方法：Python 全量解析 templates.json（46 平台 221 格式，含 purerContent 内嵌 XML）；B–F 直读 pipeline XML 与 mapping JSON 原文；G 对 fundParse.bundle.cjs（4.86 MB）做关键词与函数级提取（含 Unicode 转义形式）
- 结论先行：**7 条断言全部 ✅；错误清单空；未证实项空**

## 逐条结论

| # | 断言 | 结论 | 证据 |
|---|---|---|---|
| A | 221 格式中 160 带 purerContent；ePureRegAbsolute 共 16 个，A 类 5 / B 类 9 / C 类 2 | ✅ | 扫描：总数 221、带 purerContent 160、含 ePureRegAbsolute 16，与文档一致。16 个按 templates.json formats 顺序 ↔ pipeline 文件名编号一一对应（内容逐字相等）。A 类 5 个（农行005、招行001/002/004、资金查控平台2-003）均含「借贷标志(+)」列 CondReplace：eMeetCondNumGT 0→进、eMeetCondNumLTEQ 0→出（原金额正负生成方向）+「交易金额(+)」列 ePureRegAbsolute（见 pipeline\nyyh__农业银行__005__银行交易流水.xml:1 列21/22；pipeline\zsyh__招商银行__001/002/004__银行交易流水.xml:1；pipeline\zjck__资金查控平台2__003__交易明细2.xml:1 列15/16）。B 类 9 个（广发004、湖北002、汉口001、建行003/006/010、兴业002、邮储002、招行003）每个 purerContent 均含 FindAndReplace「进-→出」「出-→进」+ ePureRegAbsolute（templates.json 字段级 + 对应 9 个 pipeline XML:1）。C 类 2 个：农行003（pipeline\nyyh__农业银行__003__银行交易流水.xml:1 列11 仅 ePureRegAbsolute、列20 仅贷→进/借→出）、资金查控平台2-001（pipeline\zjck__资金查控平台2__001__交易明细.xml:1 列6 仅 ePureRegAbsolute；mapping\zjck__资金查控平台2__42.json「借贷标志」→「收付标志」，方向沿用原列）。160−16=144 与文档「其余 144 个」吻合 |
| B | 广发004 配置链：出账→出/入账→进 → 拼接金额 → 进-→出、出-→进 → 取首字符 → 金额取绝对值（交易金额2）→ mapping 取「交易金额2」+「借贷标识」 | ✅ | pipeline\gfyh__广发银行__004__银行交易流水.xml:1：列11 借贷标识依次为 FindAndReplace 出账→出、入账→进，concatenate 拼接「交易金额」（addPlace=0），FindAndReplace 进-→出、出-→进，ePureRegExtractData START_POS=1 END_POS=1（取首字符）；列21 交易金额2 = ColumnMod 引用「交易金额」+ ePureRegAbsolute。mapping\gfyh__广发银行__05.json（formats[3]，pipeline_file=004）：「交易金额」→「交易金额2」、「借贷标志」→「借贷\n标识」 |
| C | 微信格式：交易金额(分)/账户余额(分)/对手方接收金额(分) 含 IN_EXP=$/100；借贷类型「入」→「进」 | ✅ | pipeline\alipay__资金查控平台__006__微信个人交易流水.xml:1：列6/7/18 三列均为 ePureRegCustomFunc，RegParam name="IN_EXP" 值 "$/100"；列2 借贷类型 FindAndReplace MATCH=入 REPLACE=进。注记：文档「IN_EXP=$/100」是参数简写，原文为 name="IN_EXP" 值 "$/100"，语义一致 |
| D | 农行003：金额取绝对值，方向仅「贷→进、借→出」 | ✅ | pipeline\nyyh__农业银行__003__银行交易流水.xml:1：列11 交易金额 仅 <PurerReg regtype="ePureRegAbsolute"/>；列20 借贷标志 仅两个 FindAndReplace（贷→进、借→出），无反转类逻辑 |
| E | 农行005：原金额正负生成借贷标志（>0进、<=0出）+ 绝对值金额 | ✅ | pipeline\nyyh__农业银行__005__银行交易流水.xml:1：列21 交易金额(+) = 引用「交易金额」+ ePureRegAbsolute + RemoveChar(,)；列22 借贷标志(+) = 引用「交易金额」+ CondReplace eMeetCondNumGT 0→进、eMeetCondNumLTEQ 0→出。注记：文档称「借贷标志」，实际列名「借贷标志(+)」，同义 |
| F | 公共方向词表 lendingFlagConfig.json 存在，内容为借/贷/C/D 等方向词统一 | ✅ | HYJX\_extract\main\ConfigPackage\lendingFlagConfig.json 存在：inValues=[贷,转入,C:贷,C,+,入账,1,C - 贷]，outValues=[借,转出,D:借,D,-,出账,0,D - 借] |
| G | DMSeek：mapProductNoBankRow（带符号金额拆绝对金额+方向）+ 山东农信「支出栏负数→收入、收入栏负数→支出、标记冲正」 | ✅ | mapProductNoBankRow 在 DMSeek\_app_asar\electron\agent-http\generated\fundParse.bundle.cjs:116880：out.jyje = Math.abs(signed); out.jdbz = signed > 0 ? "贷" : "借"。山东农信逻辑在同文件 :115580（mapFixedLine）与 :115692（parseShandongRuralBankTxt）：定长「存取金额」两栏——第一栏（before201810 位59-77 / after201810 位59-80）>0→借/zcje 支出、<0→贷/srje 收入并 signedReversal=true；第二栏（位77-95 / 80-101）>0→贷/srje 收入、<0→借/zcje 支出并 signedReversal=true；signedReversal 时备注追加「冲正金额」，cz 冲正标志位非 0 时备注追加「冲正:cz」。注记：文档「标记冲正」在代码中以备注文本实现（非独立字段）；「支出栏/收入栏」对应定长文本两段金额字段，语义与文档一致 |

## 出入（文档说的 vs 实际扫到的）

无实质出入。三处措辞级注记（均不影响结论）：

1. C：文档写「IN_EXP=$/100」，原文为 RegParam name="IN_EXP" 值 "$/100"。
2. E：文档称「借贷标志」，实际列名为「借贷标志(+)」（金额列同有「(+)」后缀）。
3. G：文档「标记冲正」对应代码中备注文本「冲正金额」/「冲正:cz」，非独立字段；山东农信函数在 bundle 中以英文名 parseShandongRuralBankTxt/mapFixedLine 出现（明文「山东/负数」0 命中，需按函数名与 Unicode 转义检索，检索已覆盖两者）。

## 错误清单

（空）

## 未证实项清单

（空）
