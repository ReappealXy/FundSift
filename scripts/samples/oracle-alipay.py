#!/usr/bin/env python3
"""Independent Alipay account-CSV subset oracle; never a complete G0 bundle.

Draft:    python oracle-alipay.py --source PRIVATE.csv --rule draft-rule.json --out NEWDIR
Approved: python oracle-alipay.py --source PRIVATE.csv --approved-rule approved-rule.json --out NEWDIR
Uses csv/Decimal/datetime only; no product parser, money engine or G0 validator.
Approval metadata is supplied by the human review workflow, never fabricated.
"""
from __future__ import annotations

import argparse
from collections import Counter
import csv
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext
import hashlib
import io
import json
from pathlib import Path
import re

VERSION = "1.0.0"
MAX_INT64 = 9223372036854775807
ASCII_DECIMAL = re.compile(r"(?:0|[1-9][0-9]*)(?:\.[0-9]+)?\Z")
LOCAL_TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}\Z")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def reject_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate config field: {key}")
        result[key] = value
    return result


def approved(value):
    return isinstance(value, dict) and value.get("approved") is True and all(
        isinstance(value.get(key), str) and bool(value[key].strip())
        for key in ("approved_by", "approved_at", "evidence"))


def check_rule(rule, require_approval):
    if rule.get("oracle_config_version") != 1 or rule.get("subset_type") != "alipay_account_csv":
        raise ValueError("unsupported independent subset oracle configuration")
    for key in ("source_id", "format_rule_id", "source_sha256", "encoding", "delimiter", "headers", "columns", "direction_map", "business_status", "currency", "account"):
        if key not in rule:
            raise ValueError(f"missing configuration: {key}")
    if not re.fullmatch(r"[a-f0-9]{64}", rule["source_sha256"]):
        raise ValueError("source sha256 must be pinned")
    if not isinstance(rule["headers"], list) or len(rule["headers"]) != 17 or any(not isinstance(h, str) for h in rule["headers"]):
        raise ValueError("this oracle requires an explicitly pinned 17-column header")
    if len(rule["delimiter"]) != 1 or rule.get("amount_class") != "E" or rule.get("source_unit") != "元" or rule.get("unit_scale") != 100:
        raise ValueError("this oracle supports only explicitly selected E-class yuan account CSV")
    if rule.get("rounding") != "half_up_minor_unit" or rule.get("zero_policy") != "pending" or rule.get("negative_policy") != "pending":
        raise ValueError("rounding/zero/negative policies must be explicit and conservative")
    if rule.get("time_policy") != "payment_time_only_no_fallback":
        raise ValueError("payment-time-only policy is required; no inferred fallback")
    if rule["account"].get("policy") != "preserve_composite_raw":
        raise ValueError("account composite extraction/normalization is outside this oracle")
    required_columns = ("amount", "direction", "payment_time", "account", "business_status", "summary")
    for key in required_columns:
        position = rule["columns"].get(key)
        if isinstance(position, bool) or not isinstance(position, int) or not 1 <= position <= 17:
            raise ValueError("columns must be explicit 1-based positions")
    if rule["direction_map"] != {"收入": "进", "支出": "出"}:
        raise ValueError("this subset oracle does not support implicit or extended direction words")
    status = rule["business_status"]
    if not isinstance(status.get("confirmed_words"), list) or not isinstance(status.get("pending_words"), list):
        raise ValueError("exact business state lists required")
    if set(status["confirmed_words"]) & set(status["pending_words"]):
        raise ValueError("business state lists overlap")
    currency = rule["currency"]
    if currency.get("policy") != "verified_cny_or_unknown":
        raise ValueError("only evidence-approved CNY or unknown is supported")
    if require_approval:
        if rule.get("state") != "approved" or not approved(rule.get("approval")):
            raise ValueError("--approved-rule requires an explicit human rule approval record")
        if not approved(currency.get("approval")) or not approved(rule["account"].get("approval")):
            raise ValueError("currency and composite account policies require their own approval evidence")
    elif rule.get("state") != "draft" or (rule.get("approval") or {}).get("approved") is True:
        raise ValueError("approved metadata must use --approved-rule explicitly")


def decimal_minor(text):
    """Return exact unsigned magnitude in minor units, with rounding evidence."""
    if not text:
        return None, None, "amount_missing"
    if text.startswith("-") and ASCII_DECIMAL.fullmatch(text[1:]):
        return None, None, "sign_semantics_undefined"
    if not ASCII_DECIMAL.fullmatch(text):
        return None, None, "amount_unparseable"
    try:
        with localcontext() as context:
            context.prec = max(64, len(text) + 16)
            exact = Decimal(text) * Decimal(100)
            rounded = exact.quantize(Decimal("1"), rounding=ROUND_HALF_UP)
            if rounded > MAX_INT64:
                return None, None, "amount_out_of_range"
            magnitude = int(rounded)
            return str(magnitude), format(rounded - exact, "f"), "zero_rule_undefined" if magnitude == 0 else None
    except (InvalidOperation, ValueError):
        return None, None, "amount_unparseable"


def local_payment_time(text):
    if not text:
        return None, "time_missing"
    if not LOCAL_TIME.fullmatch(text):
        return None, "time_invalid"
    try:
        datetime.strptime(text, "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None, "time_invalid"
    return text, None


def derive(record, headers, source_loc, rule, require_approval):
    cols = rule["columns"]
    value = lambda name: record[cols[name] - 1]
    reasons = []

    def add(code, detail):
        if code and not any(reason["reason_code"] == code for reason in reasons):
            reasons.append({"reason_code": code, "detail": detail})

    if not require_approval:
        add("rule_unapproved", "候选规则未获人工批准；本行为草稿预期，不是可发布答案")
    magnitude, rounding_delta, amount_reason = decimal_minor(value("amount"))
    add(amount_reason, "原始金额不能按本候选E类元单位政策直接确认")
    direction = rule["direction_map"].get(value("direction"))
    if direction is None:
        add("direction_missing" if not value("direction") else "direction_unknown", "原方向不在此格式已列出的收入/支出词表内")
    amount = None
    if magnitude is not None and direction is not None:
        # The Decimal magnitude is converted to a signed decimal integer string,
        # never to a floating point number or a rounded JSON numeric literal.
        amount = str(int(magnitude) * (1 if direction == "进" else -1))
    txn_time, time_reason = local_payment_time(value("payment_time"))
    add(time_reason, "只读付款时间；原时间缺失、格式或含义未批准时不回退创建/修改时间")
    account_text = value("account")
    account_present = bool(account_text.strip())
    account_approved = require_approval and approved(rule["account"].get("approval"))
    acct_no = account_text if account_present and account_approved else None
    if not account_present:
        add("account_missing", "本方用户信息为空，不能由姓名或其它字段猜补")
    elif not account_approved:
        add("account_identity_policy_unapproved", "复合平台用户信息的标识含义与保留政策尚未批准，原文保留不拆分")
    currency = "CNY" if require_approval and approved(rule["currency"].get("approval")) else None
    if currency is None:
        add("currency_missing", "原件无币种列，尚无本具体格式已批准的CNY来源证据")
    business_status = value("business_status")
    if business_status in rule["business_status"]["pending_words"]:
        add("business_status_closed", "原始业务状态要求待核；仍保留原记录和已知字段")
    elif business_status not in rule["business_status"]["confirmed_words"]:
        add("business_status_unknown", "原始业务状态不在该规则精确词表内，不能用成功/退款子串猜测")
    domain_reasons = [reason for reason in reasons if reason["reason_code"] not in {"rule_unapproved", "account_identity_policy_unapproved", "currency_missing"}]
    layer = "B" if domain_reasons else "A"
    return {
        "source_id": rule["source_id"], "source_sha256": rule["source_sha256"], "source_loc": source_loc,
        "format_rule_id": rule["format_rule_id"], "rule_version": rule.get("rule_version", 1),
        "subset": True, "layer": layer, "review": False, "reviewer": None,
        "raw": {"fields": [{"position": i + 1, "header": header, "text": text} for i, (header, text) in enumerate(zip(headers, record))],
                "raw_amount_text": value("amount"), "raw_direction": value("direction"),
                "txn_time_text": value("payment_time"), "acct_no": account_text, "currency_text": None,
                "business_status": business_status, "summary": value("summary")},
        "expected": {"amount": amount, "amount_magnitude_minor": magnitude, "direction": direction,
                     "txn_time": txn_time, "acct_no": acct_no, "currency": currency,
                     "status": "pending" if reasons else "confirmed", "pending_reasons": reasons,
                     "business_status": business_status, "balance": None, "balance_scope": "unknown", "reversal_flag": 0},
        "basis": {"amount_class": "E", "source_unit": "元", "unit_scale": 100,
                  "time_policy": "payment_time_only_no_fallback", "account_policy": "preserve_composite_raw",
                  "rounding_delta_minor": rounding_delta,
                  "note": "机械预期不等于人工业务裁决；可以退款不表示已退款；不作跨文件去重或余额链"}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, required=True)
    selected = parser.add_mutually_exclusive_group(required=True)
    selected.add_argument("--rule", type=Path)
    selected.add_argument("--approved-rule", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    rule_path = args.approved_rule or args.rule
    rule_bytes = rule_path.read_bytes()
    rule = json.loads(rule_bytes.decode("utf-8"), object_pairs_hook=reject_duplicates)
    require_approval = args.approved_rule is not None
    check_rule(rule, require_approval)
    source = args.source.resolve(strict=True)
    before = source.stat()
    data = source.read_bytes()
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or sha256(data) != rule["source_sha256"]:
        raise ValueError("source changed or does not match pinned source sha256")
    text = data.decode(rule["encoding"], errors="strict")
    records = list(csv.reader(io.StringIO(text, newline=""), delimiter=rule["delimiter"], strict=True))
    if not records or records[0] != rule["headers"]:
        raise ValueError("source header differs from explicitly pinned format")
    if any(len(row) != 17 or not any(row) or row == records[0] for row in records[1:]):
        raise ValueError("unexpected empty, repeated-header or mismatched-width record; no silent skipping")
    rows = [derive(record, records[0], str(i), rule, require_approval) for i, record in enumerate(records[1:], 2)]
    if len(rows) != rule.get("expected_data_records"):
        raise ValueError("source data record count differs from pinned subset")
    answers = "".join(dump(row) + "\n" for row in rows).encode("utf-8")
    reasons = Counter(reason["reason_code"] for row in rows for reason in row["expected"]["pending_reasons"])
    report = {"oracle_version": VERSION, "oracle_sha256": sha256(Path(__file__).read_bytes()),
              "source_id": rule["source_id"], "source_sha256": sha256(data), "source_bytes": len(data),
              "rule_sha256": sha256(rule_bytes), "answers_sha256": sha256(answers),
              "state": "rule_approved_subset_candidate" if require_approval else "unapproved_subset_draft",
              "rule_approval_supplied": require_approval, "row_reviews_approved": False,
              "frozen": False, "g0_complete": False, "ready_for_m1": False,
              "counts": {"logical_records": len(records), "header": 1, "data": len(rows),
                         "status": dict(Counter(row["expected"]["status"] for row in rows)),
                         "layer": dict(Counter(row["layer"] for row in rows)), "pending_reason_occurrences": dict(reasons)},
              "independence": "stdlib csv + Decimal + datetime; no production or G0 imports",
              "limitations": ["single pinned Alipay account CSV subset only", "approval records are supplied evidence, not established by this tool",
                              "row reviews remain false; B-layer human decisions are not synthesized", "not a schema-conformant complete G0 bundle",
                              "cannot freeze a full dataset or approve business correctness"]}
    out = args.out.resolve()
    if out.exists() and any(out.iterdir()):
        raise ValueError("output directory must be new or empty; do not overwrite a prior answer version")
    out.mkdir(parents=True, exist_ok=True)
    (out / "answers.jsonl").write_bytes(answers)
    (out / "rule-input.json").write_bytes(rule_bytes)
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"state": report["state"], "counts": report["counts"], "frozen": False, "g0_complete": False}, ensure_ascii=True))


if __name__ == "__main__":
    main()
