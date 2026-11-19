'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ArchiveStore } = require('../archive-store.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fundsift-archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'synthetic.csv');
  fs.writeFileSync(source, '原始字段,金额\r\n合成记录,1.23\r\n');
  return { root, source, store: new ArchiveStore(root) };
}
test('复制前后身份复验，内容归档及持久恢复清单，重复文件不覆盖', async t => {
  const { root, source, store } = fixture(t), bytes = fs.readFileSync(source);
  const expected = createHash('sha256').update(bytes).digest('hex');
  const progress = [];
  const one = await store.stage(source, { expectedSha256: expected, onProgress: p => progress.push(p) });
  assert.equal(one.state, 'ready'); assert.equal(one.copiedSha256, expected);
  assert.deepEqual(fs.readFileSync(path.join(root, one.finalRelativePath)), bytes);
  const two = await store.stage(source);
  assert.notEqual(one.taskId, two.taskId); assert.equal(one.finalRelativePath, two.finalRelativePath);
  const recovery = new ArchiveStore(root).inspectRecovery();
  assert.equal(recovery.length, 2); assert.ok(recovery.every(r => r.finalExists && !r.stagingExists));
  assert.equal(progress.at(-1).copiedBytes, bytes.length.toString());
  assert.deepEqual(fs.readFileSync(source), bytes);
});
test('既有归档损坏、原件哈希不符、复制过程中修改原件均拒绝假成功', async t => {
  const { root, source, store } = fixture(t);
  await assert.rejects(store.stage(source, { expectedSha256: '0'.repeat(64) }), { code: 'FS_ARCHIVE_CHANGED' });
  const one = await store.stage(source);
  fs.writeFileSync(path.join(root, one.finalRelativePath), 'corrupt');
  await assert.rejects(store.stage(source), { code: 'FS_ARCHIVE_HASH' });
  fs.writeFileSync(source, Buffer.alloc(300000, 65));
  let changed = false;
  await assert.rejects(store.stage(source, { onProgress() {
    if (!changed) { changed = true; fs.appendFileSync(source, 'changed'); }
  } }), { code: 'FS_ARCHIVE_CHANGED' });
});
test('失败恢复只清理本任务staging，引用与宽限期挡删除，最终原件副本始终保留', async t => {
  const { root, source, store } = fixture(t);
  const one = await store.stage(source);
  assert.throws(() => store.cleanupStaging(one.taskId, { isReferenced: () => true, graceMs: 0 }), { code: 'FS_ARCHIVE_REFERENCED' });
  assert.throws(() => store.cleanupStaging(one.taskId, { isReferenced: () => false }), { code: 'FS_ARCHIVE_GRACE' });
  const result = store.cleanupStaging(one.taskId, { isReferenced: () => false, graceMs: 0 });
  assert.equal(result.finalRetained, true); assert.ok(fs.existsSync(path.join(root, one.finalRelativePath)));
  assert.throws(() => store.cleanupStaging('../escape', { isReferenced: () => false }), { code: 'FS_ARCHIVE_INPUT' });
});
test('取消保留可诊断终态，不发布结果，损坏清单不自动清理', async t => {
  const { root, source, store } = fixture(t), controller = new AbortController();
  fs.writeFileSync(source, Buffer.alloc(400000, 65));
  await assert.rejects(store.stage(source, { signal: controller.signal, onProgress() { controller.abort(); } }), { code: 'FS_USER_CANCELLED' });
  assert.equal(store.inspectRecovery()[0].state, 'failed');
  assert.equal(store.inspectRecovery()[0].finalExists, false);
  fs.writeFileSync(path.join(root, 'archive/.journal', store.inspectRecovery()[0].taskId + '.json'), '{}');
  assert.equal(store.inspectRecovery()[0].requiresReview, true);
});
test('日志rename前崩溃遗留.new时恢复清理仍可重试，最终副本不删', async t => {
  const { root, source, store } = fixture(t), one = await store.stage(source);
  const stale = path.join(root, 'archive/.journal', one.taskId + '.json.new');
  fs.writeFileSync(stale, '{"interrupted":');
  assert.equal(store.inspectRecovery()[0].interruptedJournal, true);
  store.cleanupStaging(one.taskId, { isReferenced: () => false, graceMs: 0 });
  assert.equal(fs.existsSync(stale), false);
  assert.equal(store.inspectRecovery()[0].state, 'staging_cleaned');
  assert.equal(store.inspectRecovery()[0].finalExists, true);
});
