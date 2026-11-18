'use strict';

const path = require('node:path');

// Inspection and cancellation do not create any files. The store checks the
// inspected directory token again when it actually creates the workspace.
async function chooseWorkspace({ window, dialog, worker, onProgress = () => {} }) {
  const progress = phase => { try { onProgress(phase); } catch (_) { /* Feedback must not affect the user's selection. */ } };
  for (;;) {
    progress('choosing-location');
    const selected = await dialog.showOpenDialog(window, {
      title: '选择数据存放文件夹', properties: ['openDirectory', 'createDirectory']
    });
    if (selected.canceled || !selected.filePaths[0]) return { cancelled: true };
    const candidate = path.resolve(selected.filePaths[0]);
    const inspection = await worker.request('inspectWorkspace', candidate);
    if (inspection.needsConfirmation) {
      progress('confirming-location');
      const answer = await dialog.showMessageBox(window, {
        type: 'question', title: '在这里保存案件？',
        message: '这里已经有文件，是否仍在这里保存案件？',
        detail: `数据存放位置：${candidate}\n\n软件会新增案件数据文件和案件子文件夹，已有文件会保留，不会导入其中的流水材料。建议选择单独、准备长期保留的文件夹。\n\n将新增 workspace.sqlite 和 cases 文件夹。`,
        buttons: ['在此创建', '重新选择', '取消'], defaultId: 1, cancelId: 2, noLink: true
      });
      if (answer.response === 2) return { cancelled: true };
      if (answer.response !== 0) continue;
    }
    const state = await worker.request('openWorkspace', candidate, {
      allowCreate: true, confirmationToken: inspection.confirmationToken
    });
    return { candidate, state };
  }
}

module.exports = { chooseWorkspace };
