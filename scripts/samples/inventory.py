#!/usr/bin/env python3
"""Independent, read-only structural inventory of explicitly selected samples.

Usage: python inventory.py --manifest PRIVATE/selection.json --out PRIVATE/output
No production parser, monetary engine or G0 validator is imported. A selection
names a file and optionally a zip/tar member chain. Originals are never written.
This produces evidence and candidate coordinate indexes, not business answers.
"""
from __future__ import annotations

import argparse
import collections
import csv
import hashlib
import io
import json
import re
from pathlib import Path
import tarfile
import xml.etree.ElementTree as ET
import zipfile

VERSION = "1.0.0"
NS = {"s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id"
INT_OR_DECIMAL = re.compile(r"^[+-]?\d+(?:\.\d+)?$")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def load_selected(source):
    file = Path(source["path"]).resolve(strict=True)
    before = file.stat()
    data = file.read_bytes()
    after = file.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise ValueError(f"source changed during read: {source['id']}")
    lineage = [{"kind": "file", "path": str(file), "bytes": len(data), "sha256": digest(data)}]
    for step in source.get("members", []):
        if step["container"] == "zip":
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = [entry for entry in archive.infolist() if entry.filename == step["name"]]
                if len(entries) != 1 or entries[0].is_dir():
                    raise ValueError("archive member missing, duplicated or not a file")
                data = archive.read(entries[0])
        elif step["container"] == "tar":
            with tarfile.open(fileobj=io.BytesIO(data), mode="r:*") as archive:
                entries = [entry for entry in archive.getmembers() if entry.name == step["name"]]
                if len(entries) != 1 or not entries[0].isfile():
                    raise ValueError("tar member missing, duplicated or not a file")
                data = archive.extractfile(entries[0]).read()
        else:
            raise ValueError("unsupported container")
        lineage.append({"kind": step["container"] + "_member", "name": step["name"],
                        "bytes": len(data), "sha256": digest(data)})
    return data, lineage


def normalized(value):
    return value.strip() if isinstance(value, str) else value


def column_stats(values, kind):
    cleaned = [normalized(value) for value in values]
    counter = collections.Counter(cleaned)
    result = {"nonempty": sum(bool(v) for v in cleaned), "empty": sum(not v for v in cleaned),
              "distinct_nonempty": len({v for v in cleaned if v})}
    if kind in ("direction", "state", "currency", "business_type"):
        result["values"] = dict(sorted(counter.items()))
    elif kind == "amount":
        text_values = [v for v in cleaned if v]
        numeric = [v for v in text_values if INT_OR_DECIMAL.fullmatch(v)]
        result.update({"decimal_syntax": len(numeric), "negative_syntax": sum(v.startswith("-") for v in numeric),
                       "zero_syntax": sum(not any(c in "123456789" for c in v) for v in numeric),
                       "literal_null": counter.get("null", 0),
                       "other_text_values": dict(collections.Counter(v for v in text_values if not INT_OR_DECIMAL.fullmatch(v)))})
    elif kind == "time":
        text_values = [v for v in cleaned if v]
        result["lexical_min"] = min(text_values) if text_values else None
        result["lexical_max"] = max(text_values) if text_values else None
        result["lengths"] = dict(sorted(collections.Counter(map(len, text_values)).items()))
        result["note"] = "lexical bounds only; not parsed/approved transaction timestamps"
    elif kind == "identity":
        # This only detects distinct raw identifiers. It does not merge people,
        # cards, accounts, names, or variants of a composite platform field.
        result["trimmed_value_sha256_counts"] = {
            digest(str(k).encode("utf-8")): count for k, count in sorted(counter.items()) if k
        }
    return result


def inspect_columns(headers, rows, locs, inspection):
    result = []
    for spec in inspection:
        index = spec["position"] - 1
        if index < 0 or index >= len(headers):
            raise ValueError("inspection column outside header")
        values = [row[index] for row in rows]
        item = {"position": index + 1, "header": headers[index], "kind": spec["kind"],
                **column_stats(values, spec["kind"])}
        if spec["kind"] in ("time", "identity", "amount", "currency"):
            item["empty_source_locs"] = [loc for loc, value in zip(locs, values) if not normalized(value)]
        if spec["kind"] == "amount":
            item["negative_source_locs"] = [loc for loc, value in zip(locs, values)
                                             if INT_OR_DECIMAL.fullmatch(normalized(value)) and normalized(value).startswith("-")]
            item["zero_source_locs"] = [loc for loc, value in zip(locs, values)
                                         if INT_OR_DECIMAL.fullmatch(normalized(value)) and not any(c in "123456789" for c in normalized(value))]
        result.append(item)
    return result


def inspect_delimited(data, source):
    encoding = source["encoding"]
    decoded = data.decode(encoding, errors="strict")
    bom = "utf-8" if data.startswith(b"\xef\xbb\xbf") else ("utf-16-le" if data.startswith(b"\xff\xfe") else ("utf-16-be" if data.startswith(b"\xfe\xff") else None))
    if decoded.startswith("\ufeff"):
        decoded = decoded[1:]
    reader = csv.reader(io.StringIO(decoded, newline=""), delimiter=source["delimiter"], strict=True)
    all_rows, physical_spans, previous = [], [], 0
    for record in reader:
        all_rows.append(record)
        physical_spans.append((previous + 1, reader.line_num))
        previous = reader.line_num
    if not all_rows:
        raise ValueError("selected delimited file is empty")
    headers = all_rows[0]
    indexes, records, data_locs, anomalies = [], [], [], []
    for i, row in enumerate(all_rows, 1):
        loc = str(i)
        if i == 1:
            kind = "header"
        elif not row or all(not normalized(v) for v in row):
            kind = "other"
        elif row == headers:
            kind = "header"
        elif len(row) == len(headers):
            kind = "data"
            records.append(row)
            data_locs.append(loc)
        else:
            kind = "other"
            anomalies.append({"source_loc": loc, "reason": "column_count_differs", "columns": len(row)})
        indexes.append({"source_loc": loc, "kind": kind})
    counts = dict(collections.Counter(item["kind"] for item in indexes))
    multi = [{"source_loc": str(i), "physical_start": span[0], "physical_end": span[1]}
             for i, span in enumerate(physical_spans, 1) if span[1] > span[0]]
    keywords = source.get("candidate_keywords", [])
    candidate_rows = []
    for loc, row in zip(data_locs, records):
        hits = [word for word in keywords if any(word in v for v in row)]
        if hits:
            candidate_rows.append({"source_loc": loc, "keywords": hits,
                                   "column_positions": [i + 1 for i, v in enumerate(row) if any(word in v for word in hits)]})
    newline_count = len(re.findall(r"\r\n|\r|\n", decoded))
    physical_lines = newline_count + (1 if decoded and not decoded.endswith(("\r", "\n")) else 0)
    nonstandard = collections.Counter(f"U+{ord(c):04X}" for c in decoded if c in "\v\f\x1c\x1d\x1e\x85\u2028\u2029")
    return {"encoding": encoding, "strict_decode": True, "bom": bom, "delimiter": source["delimiter"],
            "logical_records": len(all_rows), "physical_lines": physical_lines,
            "physical_line_definition": "CRLF, LF, CR only; Unicode/control separators are field evidence",
            "nonstandard_line_separator_characters": dict(nonstandard),
            "nonstandard_line_separator_records": [str(i) for i, row in enumerate(all_rows, 1)
                                                    if any(any(c in "\v\f\x1c\x1d\x1e\x85\u2028\u2029" for c in value) for value in row)],
            "headers": [{"position": i + 1, "raw": name} for i, name in enumerate(headers)],
            "duplicate_header_texts": {k: v for k, v in collections.Counter(headers).items() if v > 1},
            "column_widths": dict(sorted(collections.Counter(map(len, all_rows)).items())),
            "record_counts": {key: counts.get(key, 0) for key in ("data", "header", "footer", "other")},
            "multiline_records": multi, "structural_anomalies": anomalies,
            "classification": "candidate data by row shape; business meaning/rules unapproved",
            "column_observations": inspect_columns(headers, records, data_locs, source.get("inspect", [])),
            "keyword_candidate_rows": candidate_rows}, indexes


def col_number(reference):
    letters = re.match(r"[A-Z]+", reference).group()
    value = 0
    for letter in letters:
        value = value * 26 + ord(letter) - 64
    return value


def inspect_xlsx(data, source):
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        properties = workbook.find("s:workbookPr", NS)
        date1904 = properties is not None and properties.get("date1904", "0") in ("1", "true")
        rels = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        targets = {rel.get("Id"): rel.get("Target") for rel in rels}
        shared = []
        if "xl/sharedStrings.xml" in archive.namelist():
            for si in ET.fromstring(archive.read("xl/sharedStrings.xml")).findall("s:si", NS):
                shared.append("".join(t.text or "" for t in si.findall(".//s:t", NS)))
        numfmts, style_formats = {}, []
        if "xl/styles.xml" in archive.namelist():
            styles = ET.fromstring(archive.read("xl/styles.xml"))
            numfmts = {item.get("numFmtId"): item.get("formatCode") for item in styles.findall("s:numFmts/s:numFmt", NS)}
            style_formats = [item.get("numFmtId") for item in styles.findall("s:cellXfs/s:xf", NS)]
        sheets, indexes = [], []
        for sheet in workbook.findall("s:sheets/s:sheet", NS):
            name = sheet.get("name")
            target = targets[sheet.get(REL)]
            member = target.lstrip("/") if target.startswith("/") else "xl/" + target
            xml = ET.fromstring(archive.read(member))
            stored_rows = xml.findall("s:sheetData/s:row", NS)
            cells_by_row, types, formulas, style_usage = [], collections.Counter(), 0, collections.Counter()
            raw_types_by_column = collections.defaultdict(collections.Counter)
            for row in stored_rows:
                cells = {}
                for cell in row.findall("s:c", NS):
                    position = col_number(cell.get("r"))
                    celltype = cell.get("t", "n")
                    types[celltype] += 1
                    raw_types_by_column[position][celltype] += 1
                    style = cell.get("s", "0")
                    style_usage[style] += 1
                    formula = cell.find("s:f", NS)
                    formulas += formula is not None
                    value = cell.find("s:v", NS)
                    text = value.text if value is not None and value.text is not None else ""
                    if celltype == "s":
                        text = shared[int(text)] if text else ""
                    elif celltype == "inlineStr":
                        text = "".join(t.text or "" for t in cell.findall(".//s:t", NS))
                    cells[position] = text
                cells_by_row.append((int(row.get("r")), cells))
            width = max((max(cells, default=0) for _, cells in cells_by_row), default=0)
            headers = [cells_by_row[0][1].get(i, "") for i in range(1, width + 1)] if cells_by_row else []
            data_rows, data_locs, counts = [], [], collections.Counter()
            role = source.get("sheets", {}).get(name, "unclassified")
            for position, (rownum, cells) in enumerate(cells_by_row):
                loc = f"{name}!{rownum}"
                values = [cells.get(i, "") for i in range(1, width + 1)]
                kind = "header" if position == 0 else ("data" if role == "transactions" and any(normalized(v) for v in values) else "other")
                indexes.append({"source_loc": loc, "kind": kind})
                counts[kind] += 1
                if kind == "data":
                    data_rows.append(values)
                    data_locs.append(loc)
            merges = [item.get("ref") for item in xml.findall("s:mergeCells/s:mergeCell", NS)]
            sheet_specs = source.get("inspect_sheets", {}).get(name, [])
            sheets.append({"name": name, "role": role, "stored_rows": len(stored_rows), "columns": width,
                           "first_stored_row": cells_by_row[0][0] if cells_by_row else None,
                           "last_stored_row": cells_by_row[-1][0] if cells_by_row else None,
                           "row_number_gaps": sum(max(0, b[0] - a[0] - 1) for a, b in zip(cells_by_row, cells_by_row[1:])),
                           "headers": [{"position": i + 1, "raw": value} for i, value in enumerate(headers)],
                           "record_counts": {key: counts.get(key, 0) for key in ("data", "header", "footer", "other")},
                           "merged_ranges": merges, "formula_cells": formulas, "stored_cell_types": dict(types),
                           "column_cell_types": dict(raw_types_by_column), "style_usage": dict(style_usage),
                           "column_observations": inspect_columns(headers, data_rows, data_locs, sheet_specs)})
        return {"container": "xlsx", "date_system": "1904" if date1904 else "1900", "sheets": sheets,
                "number_format_codes": numfmts, "style_num_format_ids": style_formats,
                "logical_records": len(indexes),
                "record_counts": {key: sum(item["kind"] == key for item in indexes) for key in ("data", "header", "footer", "other")},
                "classification": "stored XML row coordinates; account sheets are nontransaction metadata; transaction rows are structural candidates",
                "numeric_handling": "stored numeric XML text retained without float conversion; original prior numeric precision loss cannot be recovered"}, indexes


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    manifest_bytes = args.manifest.read_bytes()
    manifest = json.loads(manifest_bytes)
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "sources").mkdir(exist_ok=True)
    (out / "indexes").mkdir(exist_ok=True)
    sources, seen_ids = [], set()
    for source in manifest["sources"]:
        sid = source["id"]
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", sid) or sid in seen_ids:
            raise ValueError("unsafe or duplicated source id")
        seen_ids.add(sid)
        data, lineage = load_selected(source)
        if source["format"] == "xlsx":
            observations, indexes = inspect_xlsx(data, source)
        else:
            observations, indexes = inspect_delimited(data, source)
        suffix = ".xlsx" if source["format"] == "xlsx" else (".txt" if source["format"] == "txt" else ".csv")
        copy_rel = f"sources/{sid}{suffix}"
        copy_path = out / copy_rel
        if copy_path.exists() and copy_path.read_bytes() != data:
            raise ValueError("refusing to overwrite a different private source copy")
        copy_path.write_bytes(data)
        index_rel = f"indexes/{sid}.jsonl"
        index_bytes = "".join(json.dumps(item, ensure_ascii=False, separators=(",", ":")) + "\n" for item in indexes).encode("utf-8")
        (out / index_rel).write_bytes(index_bytes)
        sources.append({"id": sid, "case_ref": source["case_ref"], "role": source["role"],
                        "relationship": source.get("relationship", "unresolved"), "format": source["format"],
                        "identity": "byte-identical copy selected from original electronic material; provenance not externally authenticated",
                        "copy_path": copy_rel, "bytes": len(data), "sha256": digest(data), "lineage": lineage,
                        "coordinate_index": {"path": index_rel, "sha256": digest(index_bytes), "records": len(indexes),
                                             "independent_of_product_parser": True, "business_classification_approved": False},
                        "observations": observations})
    by_hash = collections.defaultdict(list)
    for item in sources:
        by_hash[item["sha256"]].append(item["id"])
    result = {"inventory_version": 1, "dataset_id": manifest["dataset_id"], "date": manifest["date"],
              "state": "structural_inventory_draft", "g0_complete": False, "business_rules_approved": False,
              "generator": {"name": "independent-sample-inventory", "version": VERSION,
                            "sha256": digest(Path(__file__).read_bytes()), "imports_production_code": False},
              "selection_manifest_sha256": digest(manifest_bytes), "sources": sources,
              "byte_identical_groups": [ids for ids in by_hash.values() if len(ids) > 1]}
    unique_sources = {source["sha256"]: source for source in sources}
    result["counts"] = {"selected_files": len(sources), "unique_file_bytes": len(unique_sources),
                         "candidate_data_records_with_duplicate_files": sum(s["observations"]["record_counts"]["data"] for s in sources),
                         "candidate_data_records_unique_file_bytes": sum(s["observations"]["record_counts"]["data"] for s in unique_sources.values()),
                         "note": "byte-identical material identity only; no transaction deduplication or cross-view aggregation"}
    write_json(out / "inventory.json", result)
    print(json.dumps({"state": result["state"], "counts": result["counts"],
                      "byte_identical_groups": result["byte_identical_groups"], "g0_complete": False}, ensure_ascii=False))


if __name__ == "__main__":
    main()
