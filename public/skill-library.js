import { api, downloadJson } from './api.js';

const $ = selector => document.querySelector(selector);

function sourceLabel(source) {
  try { const url = new URL(source); return `${url.hostname}${url.pathname.replace(/\/$/, '')}`; }
  catch { return source; }
}

function styleLabel(style) { return style.alias || style.name; }

export function createSkillLibrary({ onSelect, selectedStyle }) {
  const state = { styles: new Map() };
  const container = $('#saved-skills');
  const count = $('#skill-count');
  const status = $('#import-status');

  function setStatus(message, tone = 'neutral') {
    status.textContent = message;
    status.dataset.tone = tone;
  }

  function renderState(message, retry = false) {
    container.replaceChildren();
    const text = document.createElement('p'); text.className = 'skill-library-state'; text.textContent = message; container.append(text);
    if (retry) {
      const button = document.createElement('button'); button.className = 'text-button'; button.type = 'button'; button.textContent = '重新读取'; button.addEventListener('click', load); container.append(button);
    }
  }

  function cardFor(style) {
    const card = document.createElement('article'); card.className = 'saved-skill'; card.dataset.skillId = style.id;
    const label = styleLabel(style); const aliasFormId = `alias-${style.id}`;
    const select = document.createElement('button'); select.type = 'button'; select.className = 'saved-skill-select'; select.dataset.style = style.id; select.dataset.imported = 'true';
    select.setAttribute('aria-pressed', String(selectedStyle() === style.id));
    select.setAttribute('aria-label', `选择 ${label}${style.alias ? `，原名 ${style.name}` : ''}`);
    if (selectedStyle() === style.id) select.classList.add('active');
    const name = document.createElement('strong'); name.className = 'saved-skill-name'; name.textContent = label;
    const original = document.createElement('span'); original.className = 'saved-skill-original'; original.textContent = style.alias ? `原名 · ${style.name}` : '';
    const description = document.createElement('span'); description.className = 'saved-skill-description'; description.textContent = style.description;
    const metadata = document.createElement('span'); metadata.className = 'saved-skill-metadata'; metadata.textContent = style.allowText ? '允许文字排版' : '不新增文字';
    const source = document.createElement('small'); source.className = 'saved-skill-source'; source.textContent = sourceLabel(style.source); source.title = style.source;
    select.append(name); if (style.alias) select.append(original); select.append(description, metadata, source);

    const actions = document.createElement('div'); actions.className = 'saved-skill-actions';
    const edit = document.createElement('button'); edit.type = 'button'; edit.dataset.editAlias = style.id; edit.textContent = '别名'; edit.setAttribute('aria-controls', aliasFormId); edit.setAttribute('aria-expanded', 'false'); edit.setAttribute('aria-label', `编辑 ${style.name} 的本地别名`);
    const remove = document.createElement('button'); remove.type = 'button'; remove.dataset.removeStyle = style.id; remove.textContent = '移除'; remove.setAttribute('aria-label', `从本地 Skill 库移除 ${label}`);
    actions.append(edit, remove);

    const form = document.createElement('form'); form.id = aliasFormId; form.className = 'saved-skill-alias-form'; form.dataset.aliasForm = style.id; form.hidden = true;
    const aliasLabel = document.createElement('label'); aliasLabel.htmlFor = `${aliasFormId}-input`; aliasLabel.textContent = `本地别名 · ${style.name}`;
    const input = document.createElement('input'); input.id = `${aliasFormId}-input`; input.name = 'alias'; input.maxLength = 40; input.autocomplete = 'off'; input.value = style.alias || ''; input.placeholder = '例如：保留实景的纸刊拼贴';
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = '保存';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.dataset.cancelAlias = style.id; cancel.textContent = '取消';
    form.append(aliasLabel, input, save, cancel); card.append(select, actions, form); return card;
  }

  function render() {
    container.replaceChildren();
    const styles = [...state.styles.values()]; count.textContent = `${styles.length} 个已保存`;
    if (!styles.length) return renderState('尚未保存 Skill。粘贴网址后，它会在重启后继续保留。');
    for (const style of styles) container.append(cardFor(style));
  }

  async function load() {
    container.setAttribute('aria-busy', 'true'); renderState('正在读取本地 Skill…');
    try {
      const payload = await api('/api/styles');
      state.styles = new Map(payload.styles.filter(style => style.imported && style.saved).map(style => [style.id, style]));
      render();
      if (payload.warnings?.length) setStatus(payload.warnings.join(' '), 'warning');
    } catch (error) {
      state.styles.clear(); count.textContent = '读取失败'; renderState(error.message, true);
    } finally { container.setAttribute('aria-busy', 'false'); }
  }

  $('#skill-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = $('#import-style'); const input = $('#style-url'); const url = input.value.trim();
    if (!url) return setStatus('请先填写 HTTPS 地址', 'error');
    button.disabled = true; input.setAttribute('aria-busy', 'true'); setStatus('正在安全下载、解析并保存…');
    try {
      const payload = await api('/api/styles/import', { method: 'POST', json: { url } });
      const styles = payload.styles?.length ? payload.styles : [payload.style];
      for (const style of styles) state.styles.set(style.id, style);
      input.value = ''; render();
      const selected = styles[0]; const select = container.querySelector(`[data-style="${selected.id}"]`); onSelect(selected.id, select, true); select?.focus();
      setStatus(styles.length > 1 ? `已保存 ${styles.length} 个 Skill，并应用「${styleLabel(selected)}」` : `已保存并应用「${styleLabel(selected)}」`, 'success');
    } catch (error) { setStatus(error.message, 'error'); }
    finally { button.disabled = false; input.removeAttribute('aria-busy'); }
  });

  container.addEventListener('click', async event => {
    const select = event.target.closest('[data-style]');
    if (select) return onSelect(select.dataset.style, select, true);
    const edit = event.target.closest('[data-edit-alias]');
    if (edit) {
      container.querySelectorAll('[data-alias-form]').forEach(form => { form.hidden = true; form.closest('.saved-skill')?.querySelector('[data-edit-alias]')?.setAttribute('aria-expanded', 'false'); });
      const form = edit.closest('.saved-skill').querySelector('[data-alias-form]'); form.hidden = false; edit.setAttribute('aria-expanded', 'true'); form.elements.alias.focus(); form.elements.alias.select(); return;
    }
    const cancel = event.target.closest('[data-cancel-alias]');
    if (cancel) {
      const card = cancel.closest('.saved-skill'); const editButton = card.querySelector('[data-edit-alias]'); card.querySelector('[data-alias-form]').hidden = true; editButton.setAttribute('aria-expanded', 'false'); editButton.focus(); return;
    }
    const remove = event.target.closest('[data-remove-style]');
    if (!remove) return;
    const style = state.styles.get(remove.dataset.removeStyle); if (!style || !window.confirm(`从本地 Skill 库移除「${styleLabel(style)}」？`)) return;
    remove.disabled = true;
    try {
      await api(`/api/styles/${style.id}`, { method: 'DELETE' }); state.styles.delete(style.id); render(); setStatus(`已从本地移除「${styleLabel(style)}」`, 'success');
      if (selectedStyle() === style.id) onSelect('watercolor', $('#styles [data-style="watercolor"]'), false);
    } catch (error) { remove.disabled = false; setStatus(error.message, 'error'); }
  });

  container.addEventListener('submit', async event => {
    const form = event.target.closest('[data-alias-form]'); if (!form) return;
    event.preventDefault(); const style = state.styles.get(form.dataset.aliasForm); const input = form.elements.alias; const save = form.querySelector('[type="submit"]'); if (!style) return;
    input.disabled = true; save.disabled = true; setStatus(`正在保存「${style.name}」的别名…`);
    try {
      const payload = await api(`/api/styles/${style.id}`, { method: 'PATCH', json: { alias: input.value } }); state.styles.set(style.id, payload.style); render();
      setStatus(payload.style.alias ? `已设置别名「${payload.style.alias}」` : `已清除「${payload.style.name}」的别名`, 'success'); container.querySelector(`[data-edit-alias="${style.id}"]`)?.focus();
    } catch (error) { input.disabled = false; save.disabled = false; setStatus(error.message, 'error'); input.focus(); }
  });

  $('#export-skills').addEventListener('click', async () => {
    try { downloadJson(await api('/api/styles/export'), `photoassembly-skills-${new Date().toISOString().slice(0, 10)}.json`); setStatus('Skill 备份已导出，不包含 API 密钥。', 'success'); }
    catch (error) { setStatus(error.message, 'error'); }
  });

  $('#skill-backup-file').addEventListener('change', async event => {
    const file = event.target.files[0]; if (!file) return;
    try {
      const library = JSON.parse(await file.text()); const result = await api('/api/styles/import-library', { method: 'POST', json: { library, replace: false } }); await load(); setStatus(`已导入 ${result.imported} 条，当前共 ${result.total} 条 Skill。`, 'success');
    } catch (error) { setStatus(`导入失败：${error.message}`, 'error'); }
    finally { event.target.value = ''; }
  });

  return { load, render, styles: () => new Map(state.styles) };
}
