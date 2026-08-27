const $ = (selector) => document.querySelector(selector);
const state = { image: '', style: 'watercolor', name: '作品' };
const file = $('#file'), create = $('#create'), error = $('#error');

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
$('#styles').addEventListener('click', e => { const button = e.target.closest('[data-style]'); if (!button) return; $('.style.active').classList.remove('active'); button.classList.add('active'); state.style = button.dataset.style; });
$('#import-style').addEventListener('click', async () => {
  const button = $('#import-style'), status = $('#import-status'), url = $('#style-url').value.trim();
  if (!url) return status.textContent = '请先填写 HTTPS 地址';
  button.disabled = true; status.textContent = '正在安全下载并解析…';
  try {
    const response = await fetch('/api/styles/import', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ url }) });
    const payload = await response.json(); if (!response.ok) throw new Error(payload.error || '导入失败');
    const style = payload.style; const item = document.createElement('button'); item.className = 'style remote'; item.dataset.style = style.id;
    item.innerHTML = `<i class="swatch"></i><span><strong></strong><small>网络 Skill · 已安全导入</small></span>`; item.querySelector('strong').textContent = style.name;
    $('#styles').append(item); item.click(); status.textContent = `已应用「${style.name}」`;
  } catch (reason) { status.textContent = reason.message; }
  finally { button.disabled = false; }
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
