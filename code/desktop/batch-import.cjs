'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const MAX_BYTES = 64n * 1024n * 1024n;
const BATCH_FORMATS = [
  {
    key: 'alipay-account-17col-v1', name: '17列支付宝账户明细', extension: 'csv', confirmedCny: true,
    policy: '采用支付宝账户规则 v2。使用付款时间、元转分，收入记进、支出记出。证据明确的同主体余额转余额宝记录标为内部划转，保留账户变动证据，排除经济收支。无法确认的方向和关闭交易继续待核。'
  },
  {
    key: 'wechat-trades-27col-v1', name: '27列微信交易明细', extension: 'txt', confirmedCny: true,
    policy: '采用交易时间、主金额按分、入记进出记出。主金额与收款金额不符等异常保留待核，完整平台用户ID原文保留。余额仅保留，不做余额链校验。'
  },
  {
    key: 'ccb-account-32col-v1', name: '32列建行账户交易明细', extension: 'xlsx', confirmedCny: false,
    policy: '采用交易日期加交易时间、元转分、借记出贷记进。负额、零额和未知值保留待核。账号与卡号分开保留。原始币种“人民币元”按批准映射记为CNY，其它币种依证据处理。余额仅保留，不做余额链校验。'
  }
];

function batchError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sourceIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

async function inspect(filePath) {
  const stat = await fs.lstat(filePath, { bigint: true });
  if (stat.isSymbolicLink() || path.relative(filePath, await fs.realpath(filePath)) !== '') {
    throw batchError('FS_IMPORT_BATCH_LINK', '已跳过文件链接或目录链接，请直接选择原件所在位置。');
  }
  return stat;
}

async function scanBatchImport(paths, mode) {
  const files = [];
  const seenPaths = new Set();
  const formatByExtension = new Map(BATCH_FORMATS.map(format => ['.' + format.extension, format]));
  function add(filePath, relativePath, format, status, reason, identity) {
    files.push({ id: files.length + 1, name: path.basename(filePath), relativePath, filePath, identity,
      formatKey: format?.key ?? null, formatName: format?.name ?? null, status, ...(reason ? { reason } : {}) });
  }
  async function visit(filePath, relativePath, allowDirectories) {
    const format = formatByExtension.get(path.extname(filePath).toLowerCase());
    if (seenPaths.has(filePath)) return;
    seenPaths.add(filePath);
    let stat;
    try {
      stat = await inspect(filePath);
    } catch (error) {
      add(filePath, relativePath, format, 'skipped', error.code === 'FS_IMPORT_BATCH_LINK'
        ? error.message : '无法访问，原件可能已移动或当前没有读取权限。');
      return;
    }
    if (allowDirectories && stat.isDirectory()) {
      let entries;
      try {
        entries = await fs.readdir(filePath);
      } catch (_) {
        add(filePath, relativePath, null, 'skipped', '无法读取这个文件夹。');
        return;
      }
      entries.sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }));
      for (const name of entries) {
        await visit(path.join(filePath, name), path.join(relativePath, name), true);
      }
      return;
    }
    if (!stat.isFile()) {
      add(filePath, relativePath, null, 'skipped', '请选择普通文件，或从文件夹入口添加目录。');
    } else if (!format || path.basename(filePath).startsWith('~$')) {
      add(filePath, relativePath, null, 'skipped', '没有适用的流水模板。');
    } else if (stat.size > MAX_BYTES) {
      add(filePath, relativePath, format, 'skipped', '单份材料超过当前版本支持的 64 MiB。');
    } else {
      add(filePath, relativePath, format, 'ready', null, sourceIdentity(stat));
    }
  }
  for (const candidate of paths) {
    const filePath = path.normalize(candidate);
    await visit(filePath, path.basename(filePath) || '.', mode !== 'files');
  }
  return files;
}

function createBatchPreview(caseId, workspacePath, files) {
  const token = randomUUID();
  const preview = {
    token, scannedCount: files.length,
    files: files.map(({ filePath, identity, ...file }) => file)
  };
  return { token, caseId, workspacePath, files, preview };
}

function selectBatchFiles(batch, caseId, workspacePath, selection) {
  if (!batch || batch.caseId !== caseId || batch.workspacePath !== workspacePath || selection?.token !== batch.token) {
    throw batchError('FS_IMPORT_BATCH_STALE', '导入清单已失效，请重新选择材料。');
  }
  if (!Array.isArray(selection.fileIds) || selection.fileIds.length === 0 || selection.fileIds.length > batch.files.length ||
      selection.fileIds.some(id => !Number.isSafeInteger(id)) || new Set(selection.fileIds).size !== selection.fileIds.length) {
    throw batchError('FS_IMPORT_BATCH_INPUT', '请从当前清单勾选可导入的材料。');
  }
  const ids = new Set(selection.fileIds);
  const files = batch.files.filter(file => file.status === 'ready' && ids.has(file.id));
  if (files.length !== ids.size) {
    throw batchError('FS_IMPORT_BATCH_INPUT', '请从当前清单勾选可导入的材料。');
  }
  return files;
}

async function verifyBatchFile(file) {
  let stat;
  try {
    stat = await inspect(file.filePath);
  } catch (_) {
    throw batchError('FS_IMPORT_BATCH_CHANGED', '确认后无法访问原件，请重新选择这份材料。');
  }
  if (!stat.isFile() || sourceIdentity(stat) !== file.identity) {
    throw batchError('FS_IMPORT_BATCH_CHANGED', '原件自生成清单后已经变化，请重新选择这份材料。');
  }
}

module.exports = { BATCH_FORMATS, scanBatchImport, createBatchPreview, selectBatchFiles, verifyBatchFile };
