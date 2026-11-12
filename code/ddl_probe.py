import sqlite3, sys, re
sys.stdout.reconfigure(encoding='utf-8')

doc = open(r'D:\Analyze\FundSift\docs\03-第一片开发计划-并表闭环.md', encoding='utf-8').read()
m = re.search(r'```sql\n([\s\S]*?)```', doc)
if not m:
    print('FAIL: docs/03 未找到 SQL 代码块'); sys.exit(1)
ddl = m[1]

fails = 0; total = 0
def probe(name, fn, should_reject):
    global fails, total
    total += 1
    con.execute('SAVEPOINT p')
    try:
        fn()
        con.execute('ROLLBACK TO p'); con.execute('RELEASE p')
        if should_reject:
            print(f'  FAIL {name}: 可执行（本应拒绝）'); fails += 1
        else:
            print(f'  PASS {name}: 可执行（符合预期）')
    except sqlite3.IntegrityError:
        con.execute('ROLLBACK TO p'); con.execute('RELEASE p')
        if should_reject:
            print(f'  PASS {name}: 正确拦截')
        else:
            print(f'  FAIL {name}: 意外拦截'); fails += 1
    except Exception as e:
        con.execute('ROLLBACK TO p'); con.execute('RELEASE p')
        print(f'  FAIL {name}: 异常类型不符 → {type(e).__name__}: {str(e)[:60]}'); fails += 1

con = sqlite3.connect(':memory:')
con.execute('PRAGMA foreign_keys=ON')
try:
    con.executescript(ddl)
    print('PASS 0. DDL 原文建库（从 docs/03 提取）')
    total += 1
except Exception as e:
    print('FAIL 0. DDL 建库:', e); sys.exit(1)

con.execute("INSERT INTO case_info (case_no, case_name, created_at) VALUES ('C1','测试案','2026-11-12')")
con.execute("INSERT INTO format_rule (id, platform, format_key, rule_version, amount_expr, source_unit, unit_scale) VALUES (1,'测试','k1',1,'E','元',100)")
con.commit()

probe('unit配对 分+100', lambda: con.execute("INSERT INTO format_rule (platform, format_key, rule_version, amount_expr, source_unit, unit_scale) VALUES ('测试','k2',1,'E','分',100)"), True)
probe('source_unit 非法值(角)', lambda: con.execute("INSERT INTO format_rule (platform, format_key, rule_version, amount_expr, source_unit, unit_scale) VALUES ('测试','k3',1,'E','角',100)"), True)
probe('INSERT verified=1 frozen=0', lambda: con.execute("INSERT INTO format_rule (platform, format_key, rule_version, amount_expr, source_unit, unit_scale, verified, frozen) VALUES ('测试','k4',1,'E','元',100,1,0)"), True)
con.execute("INSERT INTO format_rule (id, platform, format_key, rule_version, amount_expr, source_unit, unit_scale, verified, frozen) VALUES (2,'测试','k5',1,'A','元',100,1,1)")
con.commit()
probe('frozen UPDATE', lambda: con.execute("UPDATE format_rule SET amount_expr='B' WHERE id=2"), True)
probe('frozen 解冻', lambda: con.execute("UPDATE format_rule SET frozen=0 WHERE id=2"), True)
probe('未冻结 UPDATE（对照）', lambda: con.execute("UPDATE format_rule SET source_evidence='s1' WHERE id=1"), False)
probe('置 verified=1 不同时 frozen', lambda: con.execute("UPDATE format_rule SET verified=1 WHERE id=1"), True)

# 正式执行验证动作：verified=1 + frozen=1 同语句（不回滚，模拟真实验证流程）
con.execute("UPDATE format_rule SET verified=1, frozen=1 WHERE id=1")
con.commit()
print('PASS 验证动作（verified=1+frozen=1 同语句）: 提交成功'); total += 1
probe('验证冻结后再改内容', lambda: con.execute("UPDATE format_rule SET amount_expr='C' WHERE id=1"), True)
probe('验证冻结后改单位倍率', lambda: con.execute("UPDATE format_rule SET unit_scale=1 WHERE id=1"), True)
probe('新增另一规则版本（对照）', lambda: con.execute("INSERT INTO format_rule (platform, format_key, rule_version, amount_expr, source_unit, unit_scale) VALUES ('测试','k1',2,'B','元',100)"), False)

con.execute("INSERT INTO source_file (id, case_id, file_name, file_sha256, format_rule_id, status) VALUES (1, 1, 'a.csv', 'H1', 1, 'imported')")
con.execute("INSERT INTO import_batch (id, case_id, source_file_id, started_at, parser_version, status) VALUES (10, 1, 1, 't1', 'v1', 'done')")
con.execute("UPDATE source_file SET first_batch_id=10, current_batch_id=10 WHERE id=1")
con.commit()
print('PASS 循环FK插入序列: OK'); total += 1

probe('规则版本错配', lambda: con.execute("INSERT INTO fund_flow (case_id, batch_id, source_file_id, format_rule_id, rule_version, source_loc, amount) VALUES (1,10,1,1,9,'r1',100)"), True)
probe('复合外键合法组合', lambda: con.execute("INSERT INTO fund_flow (case_id, batch_id, source_file_id, format_rule_id, rule_version, source_loc, amount) VALUES (1,10,1,1,1,'r1',100)"), False)
con.execute("INSERT INTO fund_flow (id, case_id, batch_id, source_file_id, format_rule_id, rule_version, source_loc, amount) VALUES (1, 1, 10, 1, 1, 1, 'r1', 100)")
con.commit()
probe('批内幂等（同批同文件同坐标）', lambda: con.execute("INSERT INTO fund_flow (case_id, batch_id, source_file_id, format_rule_id, rule_version, source_loc, amount) VALUES (1,10,1,1,1,'r1',200)"), True)
probe('非法status', lambda: con.execute("INSERT INTO fund_flow (case_id, batch_id, source_file_id, format_rule_id, rule_version, source_loc, amount, status) VALUES (1,10,1,1,1,'r2',100,'xxx')"), True)
probe('prev_flow_id不存在', lambda: con.execute("INSERT INTO balance_check (fund_flow_id, prev_flow_id) VALUES (1, 99999)"), True)
con.execute("INSERT INTO balance_check (fund_flow_id, prev_flow_id, balance_scope) VALUES (1, NULL, 'asset_ledger')")
con.commit()
probe('同笔第二条余额结果', lambda: con.execute("INSERT INTO balance_check (fund_flow_id, prev_flow_id) VALUES (1, NULL)"), True)

con.execute("INSERT INTO import_batch (id, case_id, source_file_id, started_at, parser_version, status) VALUES (11, 1, 1, 't2', 'v1', 'failed')")
con.commit()
probe('current指向failed（DB层允许）', lambda: con.execute("UPDATE source_file SET current_batch_id=11 WHERE id=1"), False)

print('')
print(f'=== 探针总数 {total}，失败 {fails} ===')
if fails == 0:
    print('ALL PASS')
    sys.exit(0)
else:
    print('HAS FAILURES')
    sys.exit(1)