const $ = (selector) => document.querySelector(selector);
const state = { image: '', style: 'watercolor', name: '作品', savedStyles: new Map() };
const file = $('#file'), create = $('#create'), error = $('#error');
const savedSkills = $('#saved-skills'), skillCount = $('#skill-count');

function setImportStatus(message, tone = 'neutral') {
  const status = $('#import-status'); status.textContent = message; status.dataset.tone = tone;
}

function selectStyle(button) {
  if (!button) return;
  document.querySelectorAll('[data-style]').forEach(item => { item.classList.remove('active'); item.setAttribute('aria-pressed', 'false'); });
  button.classList.add('active'); button.setAttribute('aria-pressed', 'true'); state.style = button.dataset.style;
}

function bindStyleSelection(container) {
  container.addEventListener('click', event => selectStyle(event.target.closest('[data-style]')));
}

function sourceLabel(source) {
  try { const url = new URL(source); return `${url.hostname}${url.pathname.replace(/\/$/, '')}`; }
  catch { return source; }
}

function renderLibraryState(message, retry = false) {
  savedSkills.replaceChildren(); const text = document.createElement('p'); text.className = 'skill-library-state'; text.textContent = message; savedSkills.append(text);
  if (retry) { const button = document.createElement('button'); button.className = 'skill-library-retry'; button.type = 'button'; button.textContent = '重新读取'; button.addEventListener('click', loadSavedSkills); savedSkills.append(button); }
}

function createSavedSkillCard(style) {
  const card = document.createElement('article'); card.className = 'saved-skill'; card.dataset.skillId = style.id;
  const select = document.createElement('button'); select.type = 'button'; select.className = 'saved-skill-select'; select.dataset.style = style.id;
  select.setAttribute('aria-pressed', String(state.style === style.id)); select.setAttribute('aria-label', `选择 ${style.name}`);
  if (state.style === style.id) select.classList.add('active');
  const name = document.createElement('strong'); name.className = 'saved-skill-name'; name.textContent = style.name;
  const description = document.createElement('span'); description.className = 'saved-skill-description'; description.textContent = style.description;
  const source = document.createElement('small'); source.className = 'saved-skill-source'; source.textContent = sourceLabel(style.source); source.title = style.source;
  select.append(name, description, source);
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'saved-skill-remove'; remove.dataset.removeStyle = style.id;
  remove.textContent = '移除'; remove.setAttribute('aria-label', `从本地 Skill 库移除 ${style.name}`);
  card.append(select, remove); return card;
}

function renderSavedSkills() {
  savedSkills.replaceChildren(); const styles = [...state.savedStyles.values()]; skillCount.textContent = `${styles.length} 个已保存`;
  if (!styles.length) return renderLibraryState('尚未保存 Skill。粘贴网址后，它会在重启后继续保留。');
  for (const style of styles) savedSkills.append(createSavedSkillCard(style));
}

async function loadSavedSkills() {
  savedSkills.setAttribute('aria-busy', 'true'); renderLibraryState('正在读取本地 Skill…');
  try {
    const response = await fetch('/api/styles'); const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '无法读取本地 Skill 库');
    state.savedStyles = new Map(payload.styles.filter(style => style.imported && style.saved).map(style => [style.id, style]));
    renderSavedSkills();
  } catch (reason) { state.savedStyles.clear(); skillCount.textContent = '读取失败'; renderLibraryState(reason.message, true); }
  finally { savedSkills.setAttribute('aria-busy', 'false'); }
}

function showImage(src, name = '作品') {
  state.image = src; state.name = name.replace(/\.[^.]+$/, '') || '作品';
  $('#original').src = src; $('#result').src = src; $('#empty').hidden = true; $('#preview').hidden = false;
  $('#actions').hidden = false; create.disabled = false; $('#codex-create').disabled = false; error.textContent = '';
}
function loadFile(selected) {
  if (!selected) return;
  if (!['image/png','image/jpeg','image/webp'].includes(selected.type)) return error.textContent = '请选择 PNG、JPEG 或 WebP 图片';
  if (selected.size > 10 * 1024 * 1024) return error.textContent = '图片不能超过 10MB';
  const reader = new FileReader(); reader.onload = () => showImage(reader.result, selected.name); reader.readAsDataURL(selected);
}
file.addEventListener('change', () => loadFile(file.files[0]));
for (const event of ['dragenter','dragover']) $('#drop').addEventListener(event, e => { e.preventDefault(); $('#drop').classList.add('drag'); });
for (const event of ['dragleave','drop']) $('#drop').addEventListener(event, e => { e.preventDefault(); $('#drop').classList.remove('drag'); });
$('#drop').addEventListener('drop', e => loadFile(e.dataTransfer.files[0]));
bindStyleSelection($('#styles')); bindStyleSelection(savedSkills);
$('#skill-form').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#import-style'), input = $('#style-url'), url = input.value.trim();
  if (!url) return setImportStatus('请先填写 HTTPS 地址', 'error');
  button.disabled = true; input.setAttribute('aria-busy', 'true'); setImportStatus('正在安全下载、解析并保存…');
  try {
    const response = await fetch('/api/styles/import', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ url }) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || '导入失败');
    const styles = Array.isArray(payload.styles) && payload.styles.length ? payload.styles : [payload.style];
    for (const style of styles) state.savedStyles.set(style.id, style);
    const style = styles[0]; renderSavedSkills(); input.value = '';
    const select = savedSkills.querySelector(`[data-style="${style.id}"]`); selectStyle(select); select?.focus(); setImportStatus(`已保存并应用「${style.name}」`, 'success');
    if (styles.length > 1) setImportStatus(`已保存 ${styles.length} 个 Skill，并应用「${style.name}」`, 'success');
  } catch (reason) { setImportStatus(reason.message, 'error'); }
  finally { button.disabled = false; input.removeAttribute('aria-busy'); }
});
savedSkills.addEventListener('click', async event => {
  const button = event.target.closest('[data-remove-style]'); if (!button) return;
  const id = button.dataset.removeStyle, style = state.savedStyles.get(id); if (!style) return;
  if (!window.confirm(`从本地 Skill 库移除「${style.name}」？`)) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/styles/${id}`, { method:'DELETE' }); const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || '移除失败');
    state.savedStyles.delete(id); if (state.style === id) selectStyle($('#styles [data-style="watercolor"]'));
    renderSavedSkills(); setImportStatus(`已从本地移除「${style.name}」`, 'success'); $('#style-url').focus();
  } catch (reason) { button.disabled = false; setImportStatus(reason.message, 'error'); }
});
$('#compare').addEventListener('input', e => { $('#before').style.width = `${e.target.value}%`; $('#preview').style.setProperty('--split', `${e.target.value}%`); });
$('#reset').addEventListener('click', () => { state.image = ''; state.jobId = ''; file.value = ''; $('#empty').hidden = false; $('#preview').hidden = true; $('#actions').hidden = true; $('#codex-job').hidden = true; create.disabled = true; $('#codex-create').disabled = true; });

$('#sample').addEventListener('click', async () => {
  const response = await fetch('/sample.png'); const blob = await response.blob(); const reader = new FileReader();
  reader.onload = () => showImage(reader.result, '山间晨光'); reader.readAsDataURL(blob);
});
create.addEventListener('click', async () => {
  if (!state.image) return; create.disabled = true; $('#loading').hidden = false; error.textContent = '';
  try {
    const response = await fetch('/api/stylize', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ imageDataUrl:state.image, styleId:state.style, customPrompt:$('#prompt').value }) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || '生成失败');
    $('#result').src = payload.image; $('#download').href = payload.image; $('#download').download = `${state.name}-${state.style}.png`;
  } catch (reason) { error.textContent = reason.message; }
  finally { $('#loading').hidden = true; create.disabled = false; }
});
$('#codex-create').addEventListener('click', async () => {
  const button = $('#codex-create'); button.disabled = true; error.textContent = '';
  try {
    const response = await fetch('/api/codex/jobs', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ imageDataUrl:state.image, styleId:state.style, customPrompt:$('#prompt').value }) });
    const job = await response.json(); if (!response.ok) throw new Error(job.error || '无法创建 Codex 任务');
    state.jobId = job.id; $('#codex-job').hidden = false; $('#job-id').textContent = `任务 ${job.id}`; $('#codex-task').value = job.task; $('#job-status').textContent = '等待人工使用 Codex 处理';
  } catch (reason) { error.textContent = reason.message; }
  finally { button.disabled = false; }
});
$('#copy-task').addEventListener('click', async () => { await navigator.clipboard.writeText($('#codex-task').value); $('#job-status').textContent = '任务提示已复制，请粘贴到 Codex'; });
$('#check-job').addEventListener('click', async () => {
  if (!state.jobId) return;
  try {
    const response = await fetch(`/api/codex/jobs/${state.jobId}`); const job = await response.json(); if (!response.ok) throw new Error(job.error);
    if (!job.hasResult) return $('#job-status').textContent = '仍在等待 Codex 完成处理';
    const result = `/api/codex/jobs/${state.jobId}/result`; $('#result').src = result; $('#download').href = result; $('#download').download = `${state.name}-codex.${job.output.split('.').pop()}`; $('#job-status').textContent = 'Codex 处理完成，结果已载入画布';
  } catch (reason) { $('#job-status').textContent = reason.message; }
});
fetch('/api/health').then(r => r.json()).then(data => { $('#engine').textContent = data.ai ? 'OPENAI 引擎已就绪' : '本地演示引擎'; }).catch(() => { $('#engine').textContent = '引擎离线'; });
loadSavedSkills();
