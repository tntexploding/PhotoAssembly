import { api, formatBytes } from './api.js';
import { createJobLibrary } from './job-library.js';
import { createSkillLibrary } from './skill-library.js';

const $ = selector => document.querySelector(selector);
const REQUIRED_API_VERSION = 2;
const state = {
  image: '', style: 'watercolor', importedStyle: false, name: '作品', jobId: '',
  config: { maxImageBytes: 0, openai: { configured: false } }, result: { extension: 'png', mime: 'image/png' }
};
const file = $('#file'); const create = $('#create'); const error = $('#error');

function safeName(value) {
  return (value || '作品').replace(/\.[^.]+$/, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').trim() || '作品';
}

function setAspect(width, height) {
  if (!width || !height) return;
  $('#preview').style.aspectRatio = `${width} / ${height}`;
}

function updateActionAvailability() {
  const hasImage = Boolean(state.image);
  const remoteNeedsApi = state.importedStyle && !state.config?.openai?.configured;
  create.disabled = !hasImage || remoteNeedsApi;
  $('#codex-create').disabled = !hasImage;
  $('#preview-note').textContent = remoteNeedsApi
    ? '该网络 Skill 没有伪造的本地滤镜预览；请生成 Codex 方案，或配置 OpenAI API。'
    : state.config?.openai?.configured
      ? `快速预览将使用 ${state.config.openai.model}；也可以生成 Codex 方案。`
      : '当前使用内置本地滤镜预览；网络 Skill 请生成 Codex 方案。';
}

function selectStyle(id, button, imported = button?.dataset.imported === 'true') {
  document.querySelectorAll('[data-style]').forEach(item => { item.classList.remove('active'); item.setAttribute('aria-pressed', 'false'); });
  button?.classList.add('active'); button?.setAttribute('aria-pressed', 'true'); state.style = id; state.importedStyle = Boolean(imported); updateActionAvailability();
}

function showCanvas(original, result = original, { name = '作品', width, height, enableCreation = true } = {}) {
  state.name = safeName(name); state.image = enableCreation ? original : '';
  $('#original').src = original; $('#result').src = result; $('#empty').hidden = true; $('#preview').hidden = false; $('#actions').hidden = false;
  const probe = new Image(); probe.onload = () => setAspect(width || probe.naturalWidth, height || probe.naturalHeight); probe.src = original;
  error.textContent = ''; updateActionAvailability();
}

function resetCanvas() {
  state.image = ''; file.value = ''; $('#empty').hidden = false; $('#preview').hidden = true; $('#actions').hidden = true; $('#download').hidden = false; updateActionAvailability();
}

async function loadFile(selected) {
  if (!selected) return;
  if (!state.config.maxImageBytes) { error.textContent = '本地配置仍在加载，请稍后再选择图片。'; return; }
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(selected.type)) { error.textContent = '请选择 PNG、JPEG 或 WebP 图片'; return; }
  if (selected.size > state.config.maxImageBytes) { error.textContent = `图片不能超过 ${formatBytes(state.config.maxImageBytes)}`; return; }
  const reader = new FileReader();
  reader.onload = () => showCanvas(reader.result, reader.result, { name: selected.name });
  reader.onerror = () => { error.textContent = '无法读取这张图片，请重新选择。'; };
  reader.readAsDataURL(selected);
}

file.addEventListener('change', () => loadFile(file.files[0]));
for (const eventName of ['dragenter', 'dragover']) $('#drop').addEventListener(eventName, event => { event.preventDefault(); $('#drop').classList.add('drag'); });
for (const eventName of ['dragleave', 'drop']) $('#drop').addEventListener(eventName, event => { event.preventDefault(); $('#drop').classList.remove('drag'); });
$('#drop').addEventListener('drop', event => loadFile(event.dataTransfer.files[0]));
$('#styles').addEventListener('click', event => { const button = event.target.closest('[data-style]'); if (button) selectStyle(button.dataset.style, button, false); });
$('#compare').addEventListener('input', event => $('#preview').style.setProperty('--split', `${event.target.value}%`));
$('#reset').addEventListener('click', resetCanvas);

$('#sample').addEventListener('click', async () => {
  try {
    const response = await fetch('/sample.png'); if (!response.ok) throw new Error('无法读取示例照片');
    const blob = await response.blob(); const reader = new FileReader(); reader.onload = () => showCanvas(reader.result, reader.result, { name: '山间晨光' }); reader.readAsDataURL(blob);
  } catch (reason) { error.textContent = reason.message; }
});

create.addEventListener('click', async () => {
  if (!state.image) return;
  create.disabled = true; $('#loading').hidden = false; error.textContent = '';
  try {
    const payload = await api('/api/stylize', { method: 'POST', json: { imageDataUrl: state.image, styleId: state.style, customPrompt: $('#prompt').value } });
    state.result = { extension: payload.extension, mime: payload.mime };
    $('#result').src = payload.image; $('#download').href = payload.image; $('#download').hidden = false; $('#download').download = `${safeName(state.name)}-${state.style}.${payload.extension}`;
    setAspect(payload.width, payload.height);
    if (payload.promptTruncated) error.textContent = '这个 Skill 超过 OpenAI 的提示词上限，快速预览已安全缩短；Codex 方案仍保留完整内容。';
  } catch (reason) { error.textContent = reason.message; }
  finally { $('#loading').hidden = true; updateActionAvailability(); }
});

function showJobPanel(job) {
  state.jobId = job.id; localStorage.setItem('photoassembly.lastJobId', job.id);
  $('#codex-job').hidden = false; $('#job-id').textContent = `任务 ${job.id}`; $('#codex-task').value = job.task || '任务提示文件缺失，请从任务目录读取 job.json。';
  $('#job-status').textContent = job.hasResult ? 'Codex 处理完成，结果已载入画布' : '等待人工使用 Codex 处理';
}

async function openJob(id) {
  try {
    const job = await api(`/api/codex/jobs/${id}`); showJobPanel(job);
    const input = `/api/codex/jobs/${id}/input`; const result = job.hasResult ? `/api/codex/jobs/${id}/result` : input;
    showCanvas(input, result, { name: job.style?.alias || job.style?.name || 'Codex作品', enableCreation: false });
    $('#download').hidden = !job.hasResult;
    if (job.hasResult) { const extension = job.output.split('.').pop(); $('#download').href = result; $('#download').download = `${safeName(state.name)}-codex.${extension}`; }
  } catch (reason) {
    $('#job-status').textContent = reason.message; if (reason.status === 404) { localStorage.removeItem('photoassembly.lastJobId'); state.jobId = ''; }
  }
}

const jobLibrary = createJobLibrary({
  onOpen: openJob,
  onDeleted(id) {
    if (state.jobId !== id) return;
    state.jobId = ''; localStorage.removeItem('photoassembly.lastJobId'); $('#codex-job').hidden = true; resetCanvas();
  }
});

$('#codex-create').addEventListener('click', async () => {
  if (!state.image) return;
  const button = $('#codex-create'); button.disabled = true; error.textContent = '';
  try {
    const job = await api('/api/codex/jobs', { method: 'POST', json: { imageDataUrl: state.image, styleId: state.style, customPrompt: $('#prompt').value } });
    showJobPanel({ ...job, task: job.task, hasResult: false }); await jobLibrary.load(); $('#codex-job').scrollIntoView({ block: 'nearest' });
  } catch (reason) { error.textContent = reason.message; }
  finally { updateActionAvailability(); }
});

$('#copy-task').addEventListener('click', async () => {
  const textarea = $('#codex-task');
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(textarea.value);
    else { textarea.select(); document.execCommand('copy'); }
    $('#job-status').textContent = '任务提示已复制，请粘贴到 Codex';
  } catch { $('#job-status').textContent = '浏览器未允许复制，请手动选择任务提示。'; textarea.focus(); textarea.select(); }
});
$('#check-job').addEventListener('click', () => state.jobId && openJob(state.jobId));

const skillLibrary = createSkillLibrary({ onSelect: selectStyle, selectedStyle: () => state.style });

async function initialize() {
  try {
    const health = await api('/api/health');
    if (health.apiVersion !== REQUIRED_API_VERSION || !health.config?.openai || !health.engine) {
      throw new Error('检测到仍在运行的旧版 PhotoAssembly 服务。请在项目终端停止旧进程，再重新运行 npm start，然后刷新页面；本地 Skill 和任务不会因此丢失。');
    }
    state.config = health.config;
    const engine = health.engine;
    $('#engine').dataset.state = engine.state;
    $('#engine').textContent = engine.state === 'demo' ? '本地演示引擎' : engine.state === 'verified' ? `OpenAI 已验证 · ${engine.model}` : engine.state === 'error' ? 'OpenAI 配置需检查' : `OpenAI 已配置 · ${engine.model}`;
    $('#file-limit').textContent = `或按 Enter 浏览 · PNG / JPG / WEBP · 最大 ${formatBytes(state.config.maxImageBytes)}`;
    $('#data-directory').textContent = state.config.dataDir; $('#config-image-limit').textContent = formatBytes(state.config.maxImageBytes); $('#config-hosts').textContent = state.config.styleImport.allowedHosts.join(', ');
  } catch (reason) {
    $('#engine').dataset.state = 'error'; $('#engine').textContent = '本地服务需要重启'; error.textContent = reason.message;
    $('#skill-count').textContent = '等待服务'; $('#saved-skills').textContent = '服务恢复后会重新读取原有 Skill，本地文件未被清除。';
    $('#job-count').textContent = '等待服务'; $('#job-list').textContent = '服务恢复后会重新读取原有任务。';
    updateActionAvailability(); return;
  }
  updateActionAvailability();
  const [, jobs] = await Promise.all([skillLibrary.load(), jobLibrary.load()]);
  const previous = localStorage.getItem('photoassembly.lastJobId');
  if (previous && jobs.jobs?.some(job => job.id === previous)) await openJob(previous);
  else if (previous) localStorage.removeItem('photoassembly.lastJobId');
}

initialize();
