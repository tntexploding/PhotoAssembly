import { api, formatBytes, formatDate } from './api.js';

const $ = selector => document.querySelector(selector);

export function createJobLibrary({ onOpen, onDeleted }) {
  const list = $('#job-list'); const status = $('#job-library-status');

  function setStatus(message, tone = 'neutral') { status.textContent = message; status.dataset.tone = tone; }

  function render(payload) {
    list.replaceChildren();
    const jobs = payload.jobs || []; const usage = payload.usage || {};
    $('#job-count').textContent = `${jobs.length} 个任务 · ${formatBytes(usage.bytes)}`;
    $('#clear-completed').disabled = !usage.completedCount;
    if (!jobs.length) {
      const empty = document.createElement('p'); empty.className = 'job-library-empty'; empty.textContent = '还没有本地任务。生成 Codex 方案后会显示在这里。'; list.append(empty); return;
    }
    for (const job of jobs) {
      const item = document.createElement('article'); item.className = 'job-item'; item.dataset.status = job.status;
      const open = document.createElement('button'); open.type = 'button'; open.className = 'job-open'; open.dataset.openJob = job.id;
      const name = document.createElement('strong'); name.textContent = job.style?.alias || job.style?.name || '未命名任务';
      const meta = document.createElement('span'); meta.textContent = `${job.status === 'completed' ? '已完成' : job.status === 'pending' ? '等待 Codex' : '失败'} · ${formatDate(job.createdAt)} · ${formatBytes(job.sizeBytes)}`;
      open.append(name, meta);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'job-remove'; remove.dataset.deleteJob = job.id; remove.textContent = '删除'; remove.setAttribute('aria-label', `删除 ${name.textContent} 任务`);
      item.append(open, remove); list.append(item);
    }
    if (payload.warnings?.length) setStatus(payload.warnings.join(' '), 'warning');
  }

  async function load() {
    list.setAttribute('aria-busy', 'true');
    try { const payload = await api('/api/codex/jobs'); render(payload); return payload; }
    catch (error) { setStatus(error.message, 'error'); return { jobs: [] }; }
    finally { list.setAttribute('aria-busy', 'false'); }
  }

  list.addEventListener('click', async event => {
    const open = event.target.closest('[data-open-job]'); if (open) return onOpen(open.dataset.openJob);
    const remove = event.target.closest('[data-delete-job]'); if (!remove || !window.confirm('永久删除这个本地任务及其原图和结果？')) return;
    remove.disabled = true;
    try { await api(`/api/codex/jobs/${remove.dataset.deleteJob}`, { method: 'DELETE' }); onDeleted(remove.dataset.deleteJob); setStatus('任务及其本地图片已删除。', 'success'); await load(); }
    catch (error) { remove.disabled = false; setStatus(error.message, 'error'); }
  });

  $('#clear-completed').addEventListener('click', async () => {
    if (!window.confirm('删除所有已完成任务及其原图和结果？等待中的任务不会删除。')) return;
    try { const result = await api('/api/codex/jobs/completed', { method: 'DELETE' }); for (const id of result.ids || []) onDeleted(id); setStatus(`已清理 ${result.removed} 个任务，释放 ${formatBytes(result.freedBytes)}。`, 'success'); await load(); }
    catch (error) { setStatus(error.message, 'error'); }
  });

  $('#backup-local').addEventListener('click', async () => {
    const button = $('#backup-local'); button.disabled = true; setStatus('正在创建本地备份…');
    try {
      const result = await api('/api/local-backup', { method: 'POST', json: { includeImages: $('#backup-images').checked } });
      setStatus(`备份已创建：${result.directory}（${result.fileCount} 个文件；不包含密钥）`, 'success');
    } catch (error) { setStatus(error.message, 'error'); }
    finally { button.disabled = false; }
  });

  return { load, setStatus };
}
