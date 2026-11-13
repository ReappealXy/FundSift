"""只在内存库验证 docs/03；协议 SQL 模拟不代表 worker 已实现。"""

from pathlib import Path
import sqlite3, sys, re
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

root = Path(__file__).resolve().parents[1]
doc = (root / 'docs' / '03-第一片开发计划-并表闭环.md').read_text(encoding='utf-8')
m = re.search(r'```sql\n([\s\S]*?)```', doc)
if not m:
    print('FAIL: docs/03 未找到 SQL 代码块'); sys.exit(1)
ddl = m[1]

fails = 0; total = 0
def probe(name, fn, should_reject=False):
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
print(f'SQLite {sqlite3.sqlite_version}；仅使用 :memory:；DDL 从脚本相对路径读取')
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
con.execute("INSERT INTO fund_flow (id, case_id, batch_id, source_file_id, format_rule_id, rule_version, source_loc, amount, direction, raw_amount_text) VALUES (1, 1, 10, 1, 1, 1, 'r1', 100, '进', '1.00')")
con.commit()
probe('批内幂等（同批同文件同坐标）', lambda: con.execute("INSERT INTO fund_flow (case_id, batch_id, source_file_id, format_rule_id, rule_version, source_loc, amount) VALUES (1,10,1,1,1,'r1',200)"), True)
probe('非法status', lambda: con.execute("INSERT INTO fund_flow (case_id, batch_id, source_file_id, format_rule_id, rule_version, source_loc, amount, status) VALUES (1,10,1,1,1,'r2',100,'xxx')"), True)
probe('prev_flow_id不存在', lambda: con.execute("INSERT INTO balance_check_history (fund_flow_id, input_version, prev_flow_id, checked_at) VALUES (1, 'initial', 99999, 't1')"), True)
con.execute("INSERT INTO balance_check_history (id, fund_flow_id, input_version, balance_scope, checked_at) VALUES (1, 1, 'initial', 'asset_ledger', 't1')")
con.execute("INSERT INTO balance_check (id, fund_flow_id, current_history_id) VALUES (1, 1, 1)")
con.commit()
probe('同笔第二条余额当前结果', lambda: con.execute("INSERT INTO balance_check (fund_flow_id, current_history_id) VALUES (1, 1)"), True)

con.execute("INSERT INTO import_batch (id, case_id, source_file_id, started_at, parser_version, status) VALUES (11, 1, 1, 't2', 'v1', 'failed')")
con.commit()
probe('current指向failed（DB层允许；须由worker拒绝）', lambda: con.execute("UPDATE source_file SET current_batch_id=11 WHERE id=1"), False)

assert total == 20, f'既有探针数量意外变化：{total}'
print('\n本轮增量：单位 UPDATE、逐项待核原因、余额历史与人工接受约束')


def sql(statement, params=()):
    return con.execute(statement, params)


def scalar(statement, params=()):
    return sql(statement, params).fetchone()[0]


def require(condition, message):
    if not condition:
        raise AssertionError(message)


probe('SQL提取快照与docs/03原文一致', lambda: require(
    (root / 'code' / 'ddl_extract_check.sql').read_text(encoding='utf-8') == ddl,
    'ddl_extract_check.sql 已偏离 docs/03 的 SQL 代码块'))


sql("INSERT INTO format_rule (id,platform,format_key,rule_version,amount_expr,source_unit,unit_scale) VALUES (3,'测试','mutable',1,'E','元',100)")
sql("INSERT INTO fund_flow (id,case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,status,acct_no) VALUES (2,1,10,1,1,1,'r2','pending','synthetic-account')")
sql("INSERT INTO fund_flow (id,case_id,batch_id,source_file_id,format_rule_id,rule_version,source_loc,amount,direction,status) VALUES (3,1,10,1,1,1,'r3',300,'进','confirmed')")
sql("INSERT INTO pending_reason (id,fund_flow_id,reason_code,detail,created_at) VALUES (1,2,'amount_missing','合成缺金额','t1')")
sql("INSERT INTO pending_reason (id,fund_flow_id,reason_code,detail,created_at) VALUES (2,2,'time_missing','合成缺时间','t1')")
con.commit()

probe('未冻结规则 UPDATE 错误单位配对', lambda: sql("UPDATE format_rule SET source_unit='分' WHERE id=3"), True)
probe('未冻结规则 UPDATE 合法单位配对（对照）', lambda: sql("UPDATE format_rule SET source_unit='分',unit_scale=1 WHERE id=3"))
probe('frozen DELETE', lambda: sql('DELETE FROM format_rule WHERE id=2'), True)
probe('frozen REPLACE 相同主键', lambda: sql("INSERT OR REPLACE INTO format_rule (id,platform,format_key,rule_version,amount_expr,source_unit,unit_scale) VALUES (2,'替换','replace-id',1,'E','元',100)"), True)
probe('frozen REPLACE 新主键命中原版本唯一键', lambda: sql("INSERT OR REPLACE INTO format_rule (id,platform,format_key,rule_version,amount_expr,source_unit,unit_scale) VALUES (99,'测试','k5',1,'E','元',100)"), True)
probe('同笔同码未解除原因唯一', lambda: sql("INSERT INTO pending_reason (fund_flow_id,reason_code,created_at) VALUES (2,'amount_missing','t2')"), True)
probe('待核原因悬空流水', lambda: sql("INSERT INTO pending_reason (fund_flow_id,reason_code,created_at) VALUES (99999,'amount_missing','t1')"), True)
probe('待核原因空代码', lambda: sql("INSERT INTO pending_reason (fund_flow_id,reason_code,created_at) VALUES (2,' ','t1')"), True)
probe('待核项不能直接以已解除状态插入', lambda: sql("INSERT INTO pending_reason (fund_flow_id,reason_code,created_at,resolved_at,resolution_reason) VALUES (2,'account_missing','t1','t2','依据')"), True)
probe('解除待核但缺依据', lambda: sql("UPDATE pending_reason SET resolved_at='t2' WHERE id=1"), True)
probe('解除待核但依据空白', lambda: sql("UPDATE pending_reason SET resolved_at='t2',resolution_reason=' ' WHERE id=1"), True)
probe('解除待核但时间空白', lambda: sql("UPDATE pending_reason SET resolved_at=' ',resolution_reason='依据' WHERE id=1"), True)
probe('未解除却填写解除依据', lambda: sql("UPDATE pending_reason SET resolution_reason='依据' WHERE id=1"), True)
probe('禁止删除待核原因', lambda: sql('DELETE FROM pending_reason WHERE id=1'), True)
probe('禁止解除时篡改创建事实', lambda: sql("UPDATE pending_reason SET detail='另一个原因',resolved_at='t2',resolution_reason='依据' WHERE id=1"), True)
probe('待核原因 REPLACE 同主键拒绝', lambda: sql("INSERT OR REPLACE INTO pending_reason (id,fund_flow_id,reason_code,created_at) VALUES (1,2,'another_reason','t2')"), True)
probe('待核原因 REPLACE 新主键命中未解除同码拒绝', lambda: sql("INSERT OR REPLACE INTO pending_reason (id,fund_flow_id,reason_code,created_at) VALUES (99,2,'amount_missing','t2')"), True)


def resolve_amount():
    sql("UPDATE pending_reason SET resolved_at='t2',resolution_reason='金额原件核对依据' WHERE id=1")


def try_reopen():
    resolve_amount()
    sql('UPDATE pending_reason SET resolved_at=NULL,resolution_reason=NULL WHERE id=1')


def try_rewrite_resolution():
    resolve_amount()
    sql("UPDATE pending_reason SET resolution_reason='改写旧依据' WHERE id=1")


def new_reason_after_resolved():
    resolve_amount()
    sql("INSERT INTO pending_reason (fund_flow_id,reason_code,detail,created_at) VALUES (2,'amount_missing','新发现的独立问题','t3')")
    require(scalar("SELECT count(*) FROM pending_reason WHERE fund_flow_id=2 AND reason_code='amount_missing'") == 2, '旧解除事实未保留')
    require(scalar("SELECT count(*) FROM pending_reason WHERE fund_flow_id=2 AND reason_code='amount_missing' AND resolved_at IS NULL") == 1, '未解除项数量不符')


probe('禁止重开已解除的旧待核项', try_reopen, True)
probe('禁止改写旧解除依据', try_rewrite_resolution, True)
probe('解除后同码允许新建，旧项仍保留', new_reason_after_resolved)


def aggregate_status_protocol(flow_id):
    # 仅模拟 docs/03 §4.3 聚合协议；字段完整性、写入口、并发均尚非 worker 实现。
    sql("""UPDATE fund_flow SET status=CASE
        WHEN EXISTS(SELECT 1 FROM pending_reason WHERE fund_flow_id=? AND resolved_at IS NULL)
        THEN 'pending' ELSE 'confirmed' END WHERE id=?""", (flow_id, flow_id))


def double_reason_protocol():
    require(scalar('SELECT count(*) FROM pending_reason WHERE fund_flow_id=2 AND resolved_at IS NULL') == 2, '缺双原因夹具')
    sql("UPDATE fund_flow SET amount=250,direction='进' WHERE id=2")
    resolve_amount()
    aggregate_status_protocol(2)
    require(scalar('SELECT status FROM fund_flow WHERE id=2') == 'pending', '解除金额误解除时间')
    require(scalar("SELECT count(*) FROM pending_reason WHERE fund_flow_id=2 AND reason_code='time_missing' AND resolved_at IS NULL") == 1, '时间原因丢失')
    sql("UPDATE fund_flow SET txn_time='2026-11-13 10:00:00' WHERE id=2")
    sql("UPDATE pending_reason SET resolved_at='t3',resolution_reason='时间原件核对依据' WHERE id=2")
    aggregate_status_protocol(2)
    require(scalar('SELECT status FROM fund_flow WHERE id=2') == 'confirmed', '全部解除未聚合')
    require(scalar('SELECT count(*) FROM pending_reason WHERE fund_flow_id=2 AND resolved_at IS NOT NULL') == 2, '解除事实未保留')


def db_does_not_aggregate():
    sql("INSERT INTO pending_reason (fund_flow_id,reason_code,created_at) VALUES (1,'time_missing','t1')")
    require(scalar('SELECT status FROM fund_flow WHERE id=1') == 'confirmed', 'DDL责任边界发生变化，请更新协议测试')


probe('协议 SQL 模拟：双原因逐项解除与状态聚合（非worker验收）', double_reason_protocol)
probe('责任边界：DB不自动聚合记录状态，worker必须同事务处理', db_does_not_aggregate)


def history(row_id, flow_id=1, version='v1', status='fail', **overrides):
    values = dict(id=row_id, fund_flow_id=flow_id, input_version=version,
                  prev_flow_id=None, expect_balance=1000, actual_balance=1030,
                  diff=30, balance_scope='asset_ledger', reason='合成差异',
                  status=status, checked_at='t-check', accepted_from_id=None,
                  manual_reason=None, accepted_at=None)
    values.update(overrides)
    columns = ','.join(values)
    placeholders = ','.join('?' for _ in values)
    sql(f'INSERT INTO balance_check_history ({columns}) VALUES ({placeholders})', tuple(values.values()))


def accept(row_id=3, accepted_from=2, version='v1', flow_id=1, **overrides):
    values = dict(accepted_from_id=accepted_from, manual_reason='独立余额处理依据',
                  accepted_at='t-accept')
    values.update(overrides)
    history(row_id, flow_id=flow_id, version=version, status='manual', **values)


history(2)
sql('UPDATE balance_check SET current_history_id=2 WHERE fund_flow_id=1')
history(10, flow_id=3)
con.commit()

probe('余额历史禁止 UPDATE', lambda: sql('UPDATE balance_check_history SET diff=0 WHERE id=2'), True)
probe('余额历史禁止 DELETE', lambda: sql('DELETE FROM balance_check_history WHERE id=2'), True)
probe('余额历史禁止 REPLACE 同主键', lambda: sql("INSERT OR REPLACE INTO balance_check_history (id,fund_flow_id,input_version,status,checked_at) VALUES (2,1,'replaced','pass','t-new')"), True)
probe('当前指针 UPDATE 不得跨流水', lambda: sql('UPDATE balance_check SET current_history_id=10 WHERE fund_flow_id=1'), True)
probe('当前指针 INSERT 不得跨流水', lambda: sql('INSERT INTO balance_check (fund_flow_id,current_history_id) VALUES (3,2)'), True)
probe('当前指针不得悬空', lambda: sql('UPDATE balance_check SET current_history_id=99999 WHERE fund_flow_id=1'), True)
probe('接受必须同输入版本', lambda: accept(version='v2'), True)
probe('接受必须同流水', lambda: accept(flow_id=3), True)
probe('接受不能引用非当前 unchecked 历史', lambda: accept(accepted_from=1, version='initial'), True)
probe('接受不能改差额为零', lambda: accept(diff=0), True)
probe('接受不能改实际余额', lambda: accept(actual_balance=1000), True)
probe('接受不能改原检查原因', lambda: accept(reason='抹掉原异常'), True)
probe('接受不能改原检查时间', lambda: accept(checked_at='t-new'), True)
probe('接受余额差异不能空白依据', lambda: accept(manual_reason=' '), True)
probe('接受余额差异不能缺接受时间', lambda: accept(accepted_at=None), True)
probe('非manual历史不能携带人工接受字段', lambda: history(3, accepted_from_id=2, manual_reason='依据', accepted_at='t-accept'), True)


def current_pass_cannot_accept():
    history(4, status='pass', expect_balance=1030, diff=0)
    sql('UPDATE balance_check SET current_history_id=4 WHERE fund_flow_id=1')
    accept(accepted_from=4, expect_balance=1030, diff=0)


def old_fail_cannot_accept():
    history(4, version='v2')
    sql('UPDATE balance_check SET current_history_id=4 WHERE fund_flow_id=1')
    accept()  # v1 fail 虽仍存在，但已不是当前检查。


probe('当前 pass 不能人工接受', current_pass_cannot_accept, True)
probe('切到新输入检查后旧fail不能接受', old_fail_cannot_accept, True)


def valid_accept_and_recompute_protocol():
    before = sql('SELECT amount,direction,status,raw_amount_text FROM fund_flow WHERE id=1').fetchone()
    accept()
    sql('UPDATE balance_check SET current_history_id=3 WHERE fund_flow_id=1')
    require(sql('SELECT status,diff,manual_reason FROM balance_check_current WHERE fund_flow_id=1').fetchone() == ('manual',30,'独立余额处理依据'), '接受结果/差额/依据不符')
    require(sql('SELECT amount,direction,status,raw_amount_text FROM fund_flow WHERE id=1').fetchone() == before, '余额接受改动了交易金额/状态/原值')
    require(scalar('SELECT count(*) FROM pending_reason WHERE fund_flow_id=1') == 0, '余额fail/manual错误生成阻断项')
    # 协议 SQL 模拟：实际 worker 仍须检测输入变化、影响链段并原子失效旧结论。
    history(4, version='v2', status='unchecked', expect_balance=None, actual_balance=None, diff=None, reason='新输入待重算')
    sql('UPDATE balance_check SET current_history_id=4 WHERE fund_flow_id=1')
    require(sql('SELECT status,input_version FROM balance_check_current WHERE fund_flow_id=1').fetchone() == ('unchecked','v2'), '新输入仍显示旧manual')
    history(5, version='v2', status='pass', expect_balance=1030, diff=0)
    sql('UPDATE balance_check SET current_history_id=5 WHERE fund_flow_id=1')
    require(sql('SELECT status,input_version FROM balance_check_current WHERE fund_flow_id=1').fetchone() == ('pass','v2'), '重算当前结果不符')
    require(sql('SELECT status,diff,manual_reason,accepted_from_id FROM balance_check_history WHERE id=3').fetchone() == ('manual',30,'独立余额处理依据',2), '重算丢失旧接受历史')
    require(sql('SELECT status,diff FROM balance_check_history WHERE id=2').fetchone() == ('fail',30), '重算覆写原fail')
    require(scalar('SELECT count(*) FROM balance_check WHERE fund_flow_id=1') == 1, '当前指针不唯一')
    require(sql('SELECT amount,direction,status,raw_amount_text FROM fund_flow WHERE id=1').fetchone() == before, '重算余额改动交易值')


probe('合法接受、失效与重算保旧历史（协议SQL模拟，非worker验收）', valid_accept_and_recompute_protocol)
probe('外键完整性检查', lambda: require(not sql('PRAGMA foreign_key_check').fetchall(), '外键异常'))

print('')
print(f'=== 探针总数 {total}，失败 {fails} ===')
print('责任边界：状态聚合、真实input_version生成、链段失效和过期业务提交仍须worker实现与M2/M3验收。')
print('本脚本未启动worker，未验证UI/搜索范围，未创建或迁移任何磁盘数据库。')
con.close()
if fails == 0:
    print('ALL PASS')
    sys.exit(0)
else:
    print('HAS FAILURES')
    sys.exit(1)
