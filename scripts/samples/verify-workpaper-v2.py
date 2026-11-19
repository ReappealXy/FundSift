#!/usr/bin/env python3
"""Check the frozen three-platform acceptance case against a v2 XLSX export.

Run with Python and openpyxl installed. Only aggregate counts and generic check
failures are printed. The case database is opened read-only.
"""

import argparse
from collections import Counter, defaultdict
from contextlib import closing
from decimal import Decimal
import json
from pathlib import Path
import re
import sqlite3

from openpyxl import load_workbook


ALIPAY = 'alipay-account-17col-v1'
WECHAT = 'wechat-trades-27col-v1'
CCB = 'ccb-account-32col-v1'
CLOSED = '交易中途关闭（未完成）'
OCCURRENCE = {'有收付记载': 8102, '标为关闭或未完成': 3, '记载不足以判断': 0}
FILE_NAME = re.compile(r'流水核对底稿-格式v2-数据v([0-9]+)-[0-9]{8}T[0-9]{9}Z\.xlsx\Z')
ENCODED = re.compile(r'\\(\\|u([0-9a-fA-F]{4}))')
ID_TOKEN = re.compile(r'[0-9]{17}[0-9xX]')
CURRENCY_EVIDENCE = {
    'raw_iso': '原文 ISO 币种', 'approved_map': '获准格式映射',
    'verified_cny': '导入时核实人民币来源', 'legacy_unverified': '历史保留值，币种依据未核验', 'unknown': '证据不足',
}

SQL = """SELECT f.*, s.file_sha256, s.file_name, b.parser_version, r.format_key
FROM fund_flow f JOIN source_file s ON s.id=f.source_file_id AND s.case_id=f.case_id
JOIN import_batch b ON b.id=s.current_batch_id AND b.id=f.batch_id
 AND b.source_file_id=s.id AND b.case_id=f.case_id AND b.status='done'
JOIN format_rule r ON r.id=f.format_rule_id AND r.rule_version=f.rule_version
WHERE f.case_id=1"""

HEADERS = {
    '案件编号', '案件名称', '材料名', '平台', '原件文件名', '原件 SHA256', '批次号', '格式键',
    '规则版本', '解析器版本', '工作表名', '行号／逻辑记录号', 'source_loc 原文',
    '本方账号／平台标识', '本方名称', '对方账号／平台标识', '对方名称',
    '本方银行卡号（原文）', '对方银行卡号（原文）', '摘要', '交易类型',
    '原始金额（原文）', '原始金额单位', '微信接收金额（原文，分）', '标准金额（元）',
    '原始方向（原文）', '标准方向', '原始时间（原文）', '标准交易时间', '原始余额（原文）',
    '原始币种（原文）', '标准币种', '币种依据', '业务状态（原文）', '业务状态（规则归一）',
    '原件收付记载', '原件记载说明', '证据状态（规则）', '全部待核原因码', '待核原因说明',
    '是否计入收付（派生，仅供参考）', '换算说明',
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def decode(value):
    if isinstance(value, str) and value.startswith('\\u16:'):
        return ENCODED.sub(lambda m: chr(int(m[2], 16)) if m[2] else '\\', value[5:])
    return value


def source_values(row, identity, reason_rows):
    kind = row['format_key']
    raw = json.loads(row['raw_record'])['values']
    values = {
        '案件编号': identity['case_no'], '案件名称': identity['case_name'],
        '材料名': row['file_name'], '平台': row['platform'], '原件文件名': row['file_name'],
        '原件 SHA256': row['file_sha256'], '批次号': str(row['batch_id']), '格式键': kind,
        '规则版本': str(row['rule_version']), '解析器版本': row['parser_version'],
        'source_loc 原文': row['source_loc'], '原始金额（原文）': row['raw_amount_text'],
        '原始金额单位': '分' if kind == WECHAT else '元',
        '原始方向（原文）': row['raw_direction'], '标准方向': row['direction'],
        '原始时间（原文）': row['txn_time_text'], '标准交易时间': row['txn_time'],
        '原始余额（原文）': row['raw_balance_text'], '原始币种（原文）': row['raw_currency_text'],
        '标准币种': row['currency'], '币种依据': CURRENCY_EVIDENCE[row['currency_evidence']],
        '摘要': row['summary'], '交易类型': row['txn_type'], '证据状态（规则）': '待核' if row['status'] == 'pending' else '已确认',
        '全部待核原因码': '\n'.join(code for code, _ in reason_rows),
        '待核原因说明': '\n'.join(code + (f' · {detail}' if detail else '') for code, detail in reason_rows),
    }
    if kind == ALIPAY:
        own, own_name, peer, peer_name, card, peer_card, recv, business = raw[7], None, raw[8], None, None, None, None, raw[12]
    elif kind == WECHAT:
        own, own_name, peer, peer_name, card, peer_card, recv, business = raw[0], raw[3], raw[14], raw[15], raw[10], raw[16], raw[24], None
    else:
        own, own_name, peer, peer_name, card, peer_card, recv, business = raw[2], row['acct_name'], raw[19], row['peer_name'], raw[11], None, None, None
    values.update({'本方账号／平台标识': own, '本方名称': own_name, '对方账号／平台标识': peer, '对方名称': peer_name,
                   '本方银行卡号（原文）': card, '对方银行卡号（原文）': peer_card, '微信接收金额（原文，分）': recv,
                   '业务状态（原文）': business})
    loc = row['source_loc']
    sheet, sep, number = loc.rpartition('!')
    values['工作表名'] = sheet if sep else None
    values['行号／逻辑记录号'] = number.removeprefix('record:')
    values['原件收付记载'] = ('标为关闭或未完成' if business == CLOSED else
                             '有收付记载' if row['raw_amount_text'] and row['raw_amount_text'].strip() else '记载不足以判断')
    if business == CLOSED:
        values['业务状态（规则归一）'] = '关闭／未完成'
        values['是否计入收付（派生，仅供参考）'] = '否'
    else:
        eligible = row['status'] == 'confirmed' and row['currency'] == 'CNY' and row['amount'] is not None
        values['是否计入收付（派生，仅供参考）'] = ('是' if row['amount'] else '否') if eligible else '未知'
        if kind != ALIPAY:
            values['业务状态（规则归一）'] = '原件无业务状态字段'
        elif not any(code.startswith('business_status_') for code, _ in reason_rows):
            values['业务状态（规则归一）'] = '成功'
    return values


def inspect_cells(cells, excluded):
    for cell in cells:
        require(cell.data_type != 'f', 'formula cell found')
        value = decode(cell.value)
        if isinstance(value, str):
            require(not excluded.intersection(ID_TOKEN.findall(value.upper())), 'excluded identifier found in workbook')


def verify(database, xlsx):
    filename = FILE_NAME.fullmatch(xlsx.name)
    require(filename is not None, 'filename must include schema v2, data version and UTC timestamp')
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        db.row_factory = sqlite3.Row
        identity = db.execute('SELECT case_no, case_name FROM case_info WHERE id=1').fetchone()
        db_version = db.execute('SELECT data_version FROM case_data_state WHERE id=1').fetchone()[0]
        require(str(db_version) == filename[1], 'filename and database data versions disagree')
        source = {(row['file_sha256'], row['source_loc']): row for row in db.execute(SQL)}
        reasons = defaultdict(list)
        for row in db.execute('SELECT fund_flow_id,reason_code,detail FROM pending_reason WHERE resolved_at IS NULL ORDER BY reason_code'):
            reasons[row['fund_flow_id']].append((row['reason_code'], row['detail']))

    excluded = {json.loads(row['raw_record'])['values'][16].strip().upper()
                for row in source.values() if row['format_key'] == ALIPAY}
    require(len(excluded) > 0 and all(ID_TOKEN.fullmatch(value) for value in excluded), 'missing expected excluded-source evidence')
    counts, occurrence, field_counts = Counter(), Counter(), Counter()
    notes_by_kind = {'摘要', '交易类型', '本方名称', '对方名称'}

    with closing(load_workbook(xlsx, read_only=True, data_only=False)) as workbook:
        require(workbook.sheetnames == ['流水明细', '导出说明'], 'unexpected worksheet layout')
        rows = iter(workbook['流水明细'].iter_rows())
        headers = [cell.value for cell in next(rows)]
        require(len(headers) == len(HEADERS) and set(headers) == HEADERS, 'v2 header whitelist mismatch')
        require(headers.index('原始金额单位') == headers.index('原始金额（原文）') + 1, 'original amount and unit must be adjacent')
        for number, cells in enumerate(rows, start=2):
            inspect_cells(cells, excluded)
            indexed = dict(zip(headers, cells))
            actual = {label: decode(cell.value) for label, cell in indexed.items()}
            key = actual['原件 SHA256'], actual['source_loc 原文']
            expected_row = source.pop(key, None)
            require(expected_row is not None, f'row {number}: invalid or duplicate source coordinate')
            kind = expected_row['format_key']
            reason_rows = reasons[expected_row['id']]
            expected = source_values(expected_row, identity, reason_rows)
            for label, value in expected.items():
                read = actual[label]
                require(read == value or read in (None, '') and value in (None, ''), f'row {number}: {label} differs from source')
                if value not in (None, ''):
                    require(indexed[label].data_type == 's', f'row {number}: {label} must be text')
            expected_amount = expected_row['amount']
            actual_amount = actual['标准金额（元）']
            require(actual_amount is None if expected_amount is None else
                    actual_amount is not None and Decimal(str(actual_amount)) * 100 == expected_amount,
                    f'row {number}: standard amount or empty cell mismatch')
            is_pending = expected_row['status'] == 'pending'
            require(bool(actual['原件记载说明']) == is_pending, f'row {number}: explanation coverage mismatch')
            if kind == ALIPAY and any(code == 'business_status_unknown' for code, _ in reason_rows):
                require('未获准词表' in (actual['业务状态（规则归一）'] or ''), f'row {number}: unmatched status label missing')
            counts['rows'] += 1
            counts['pending'] += is_pending
            counts['blank_standard_amount'] += actual_amount is None
            counts['reasons'] += len((actual['全部待核原因码'] or '').splitlines())
            counts['wechat_amount_pairs'] += kind == WECHAT and bool(actual['微信接收金额（原文，分）']) and is_pending
            if kind == ALIPAY:
                counts['alipay_identity_leading_tabs'] += sum((actual[name] or '').startswith('\t') for name in ('本方账号／平台标识', '对方账号／平台标识'))
            occurrence[actual['原件收付记载']] += 1
            field_counts[kind, actual['原始金额单位']] += 1
            for label in notes_by_kind:
                field_counts[kind, label] += bool((actual[label] or '').strip())

        info = []
        for cells in workbook['导出说明'].iter_rows():
            inspect_cells(cells, excluded)
            info.append([cell.value for cell in cells])
        labels = {row[0]: row[1] if len(row) > 1 else None for row in info if row and row[0] is not None}
        require(str(labels.get('底稿格式版本')) in ('2', 'v2') and str(labels.get('数据版本')) == str(db_version), 'worksheet version labels mismatch')
        require('字段来源表' in labels, 'missing source guide')
        require(any('前导制表符' in value for row in info for value in row if isinstance(value, str)), 'missing Alipay leading tab notice')

    require(not source, 'expected source coordinates were omitted')
    require(counts == {'rows': 8105, 'pending': 36, 'blank_standard_amount': 18, 'reasons': 55,
                       'wechat_amount_pairs': 15, 'alipay_identity_leading_tabs': 1214}, 'frozen acceptance counts differ')
    require(set(occurrence) <= OCCURRENCE.keys() and all(occurrence[k] == v for k, v in OCCURRENCE.items()), 'fixed occurrence labels or counts differ')
    for kind, amount_unit, count, txn_type, own_names, peer_names in [
        (ALIPAY, '元', 607, 0, 0, 0), (WECHAT, '分', 5635, 5635, 5635, 5610), (CCB, '元', 1863, 0, 1863, 1858),
    ]:
        require([field_counts[kind, label] for label in (amount_unit, '摘要', '交易类型', '本方名称', '对方名称')]
                == [count, count, txn_type, own_names, peer_names], 'platform field coverage differs')
    print(json.dumps({'rows': counts['rows'], 'pending': counts['pending'], 'blank_standard_amount': counts['blank_standard_amount'],
                      'reasons': counts['reasons'], 'occurrence': OCCURRENCE, 'excluded_id_hits': 0,
                      'alipay_identity_leading_tabs': counts['alipay_identity_leading_tabs'],
                      'wechat_amount_pairs': counts['wechat_amount_pairs']}, ensure_ascii=True))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    parser.add_argument('workpaper', type=Path)
    args = parser.parse_args()
    verify(args.database, args.workpaper)
