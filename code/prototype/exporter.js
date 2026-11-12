(function () {
  'use strict';

  const encoder = new TextEncoder();

  function xmlEscape(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  function columnName(index) {
    let name = '';
    let value = index + 1;
    while (value > 0) {
      const remainder = (value - 1) % 26;
      name = String.fromCharCode(65 + remainder) + name;
      value = Math.floor((value - 1) / 26);
    }
    return name;
  }

  function cellXml(value, ref) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value === 'number' && Number.isFinite(value)) {
      return '<c r="' + ref + '"><v>' + String(value) + '</v></c>';
    }
    if (typeof value === 'boolean') {
      return '<c r="' + ref + '" t="b"><v>' + (value ? '1' : '0') + '</v></c>';
    }
    const text = String(value);
    const preserve = /^\s|\s$/.test(text);
    return '<c r="' + ref + '" t="inlineStr"><is><t' + (preserve ? ' xml:space="preserve"' : '') + '>' + xmlEscape(text) + '</t></is></c>';
  }

  function uniqueSheetNames(sheets) {
    const used = new Set();
    return sheets.map(function (sheet, index) {
      let base = String(sheet && sheet.name || 'Sheet ' + (index + 1))
        .replace(/[\\/?*\[\]:]/g, '_').slice(0, 31) || 'Sheet ' + (index + 1);
      let name = base;
      let suffix = 2;
      while (used.has(name.toLowerCase())) {
        const tail = ' (' + suffix + ')';
        name = base.slice(0, 31 - tail.length) + tail;
        suffix += 1;
      }
      used.add(name.toLowerCase());
      return name;
    });
  }

  function worksheetXml(rows) {
    const normalized = Array.isArray(rows) ? rows : [];
    let maxColumns = 0;
    const rowXml = normalized.map(function (row, rowIndex) {
      const values = Array.isArray(row) ? row : [row];
      maxColumns = Math.max(maxColumns, values.length);
      const cells = values.map(function (value, columnIndex) {
        return cellXml(value, columnName(columnIndex) + (rowIndex + 1));
      }).join('');
      return '<row r="' + (rowIndex + 1) + '">' + cells + '</row>';
    }).join('');
    const dimension = normalized.length && maxColumns
      ? '<dimension ref="A1:' + columnName(maxColumns - 1) + normalized.length + '"/>'
      : '<dimension ref="A1"/>';
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      dimension + '<sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><sheetData>' + rowXml + '</sheetData></worksheet>';
  }

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit += 1) {
        crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function write16(view, offset, value) {
    view.setUint16(offset, value & 0xffff, true);
  }

  function write32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }

  function zipStore(entries) {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    entries.forEach(function (entry) {
      const name = encoder.encode(entry.name);
      const body = encoder.encode(entry.content);
      const checksum = crc32(body);
      const local = new Uint8Array(30 + name.length);
      const localView = new DataView(local.buffer);
      write32(localView, 0, 0x04034b50);
      write16(localView, 4, 20);
      write16(localView, 6, 0x0800);
      write16(localView, 8, 0);
      write16(localView, 10, 0);
      write16(localView, 12, 0x0021);
      write32(localView, 14, checksum);
      write32(localView, 18, body.length);
      write32(localView, 22, body.length);
      write16(localView, 26, name.length);
      write16(localView, 28, 0);
      local.set(name, 30);
      localParts.push(local, body);

      const central = new Uint8Array(46 + name.length);
      const centralView = new DataView(central.buffer);
      write32(centralView, 0, 0x02014b50);
      write16(centralView, 4, 20);
      write16(centralView, 6, 20);
      write16(centralView, 8, 0x0800);
      write16(centralView, 10, 0);
      write16(centralView, 12, 0);
      write16(centralView, 14, 0x0021);
      write32(centralView, 16, checksum);
      write32(centralView, 20, body.length);
      write32(centralView, 24, body.length);
      write16(centralView, 28, name.length);
      write16(centralView, 30, 0);
      write16(centralView, 32, 0);
      write16(centralView, 34, 0);
      write16(centralView, 36, 0);
      write32(centralView, 38, 0);
      write32(centralView, 42, localOffset);
      central.set(name, 46);
      centralParts.push(central);
      localOffset += local.length + body.length;
    });

    const centralSize = centralParts.reduce(function (sum, part) { return sum + part.length; }, 0);
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    write32(endView, 0, 0x06054b50);
    write16(endView, 4, 0);
    write16(endView, 6, 0);
    write16(endView, 8, entries.length);
    write16(endView, 10, entries.length);
    write32(endView, 12, centralSize);
    write32(endView, 16, localOffset);
    write16(endView, 20, 0);
    return new Blob(localParts.concat(centralParts, [end]), {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    });
  }

  function xlsx(sheets) {
    const input = Array.isArray(sheets) && sheets.length ? sheets : [{ name: '流水', rows: [] }];
    const names = uniqueSheetNames(input);
    const files = [];
    const contentOverrides = input.map(function (_, index) {
      return '<Override PartName="/xl/worksheets/sheet' + (index + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }).join('');
    const workbookSheets = input.map(function (_, index) {
      return '<sheet name="' + xmlEscape(names[index]) + '" sheetId="' + (index + 1) + '" r:id="rId' + (index + 1) + '"/>';
    }).join('');
    const workbookRels = input.map(function (_, index) {
      return '<Relationship Id="rId' + (index + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (index + 1) + '.xml"/>';
    }).join('') + '<Relationship Id="rId' + (input.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';

    files.push({ name: '[Content_Types].xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + contentOverrides + '</Types>' });
    files.push({ name: '_rels/.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' });
    files.push({ name: 'xl/workbook.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>' + workbookSheets + '</sheets><calcPr calcId="191029"/></workbook>' });
    files.push({ name: 'xl/_rels/workbook.xml.rels', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + workbookRels + '</Relationships>' });
    files.push({ name: 'xl/styles.xml', content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>' });
    input.forEach(function (sheet, index) {
      files.push({ name: 'xl/worksheets/sheet' + (index + 1) + '.xml', content: worksheetXml(sheet && sheet.rows) });
    });
    return zipStore(files);
  }

  function csv(rows) {
    const lines = (Array.isArray(rows) ? rows : []).map(function (row) {
      return (Array.isArray(row) ? row : [row]).map(function (value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
        let text = String(value);
        if (typeof value === 'string' && /^[\s]*[=+\-@]/.test(text)) text = "'" + text;
        return '"' + text.replace(/"/g, '""') + '"';
      }).join(',');
    }).join('\r\n');
    return new Blob(['\ufeff', lines], { type: 'text/csv;charset=utf-8' });
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = String(name || 'export');
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  window.FUND_EXPORT = { xlsx: xlsx, csv: csv, download: download };
}());
