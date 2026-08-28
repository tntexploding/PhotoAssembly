import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { config } from './config.js';
import { getStyle, getStyleSummary, removeImportedStyle, restoreImportedStyle, setImportedStyleAlias } from './styles.js';

const SCHEMA_VERSION = 1;
const MAX_SAVED_STYLES = 100;

function defaultLibraryPath() {
  return config.paths.skillLibraryFile;
}

export class SavedStyleLibrary {
  constructor(filePath = defaultLibraryPath()) {
    this.filePath = resolve(filePath);
    this.savedIds = new Set();
    this.loaded = false;
    this.loading = null;
    this.writeQueue = Promise.resolve();
    this.warnings = [];
    this.recoveredFromBackup = false;
  }

  has(id) {
    return this.savedIds.has(id);
  }

  async load() {
    if (this.loaded) return;
    if (!this.loading) this.loading = this.#loadFromDisk();
    try {
      await this.loading;
      this.loaded = true;
    } catch (error) {
      this.loading = null;
      throw error;
    }
  }

  async #loadFromDisk() {
    let raw;
    try { raw = await readFile(this.filePath, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    let payload;
    try { payload = JSON.parse(raw); }
    catch (error) {
      try {
        payload = JSON.parse(await readFile(`${this.filePath}.bak`, 'utf8'));
        this.recoveredFromBackup = true;
        this.warnings.push('主 Skill 库文件损坏，已从上一次备份恢复；下次保存会重建主文件。');
      } catch { throw new Error('本地 Skill 库文件不是有效的 JSON，且没有可用备份'); }
    }
    if (payload?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload.styles)) throw new Error('本地 Skill 库格式无效');
    for (const record of payload.styles) {
      try {
        const style = restoreImportedStyle(record);
        this.savedIds.add(style.id);
      } catch (error) {
        this.warnings.push(`已跳过一条损坏的 Skill 记录：${error.message}`);
      }
    }
  }

  getWarnings() {
    return [...this.warnings];
  }

  async exportSnapshot() {
    await this.load();
    return this.#snapshot();
  }

  async importSnapshot(payload, { replace = false } = {}) {
    await this.load();
    if (payload?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload.styles)) throw new Error('Skill 备份格式无效');
    if (payload.styles.length > MAX_SAVED_STYLES) throw new Error(`Skill 备份不能超过 ${MAX_SAVED_STYLES} 条记录`);
    const previousIds = new Set(this.savedIds);
    const previousSnapshot = this.#snapshot();
    const importedIds = [];
    try {
      if (replace) this.savedIds.clear();
      for (const record of payload.styles) {
        const style = restoreImportedStyle(record);
        this.savedIds.add(style.id);
        importedIds.push(style.id);
      }
      if (this.savedIds.size > MAX_SAVED_STYLES) throw new Error(`本地 Skill 库最多保存 ${MAX_SAVED_STYLES} 条记录`);
      await this.#enqueueWrite();
      if (replace) for (const id of previousIds) if (!this.savedIds.has(id)) removeImportedStyle(id);
    } catch (error) {
      for (const id of importedIds) if (!previousIds.has(id)) removeImportedStyle(id);
      for (const record of previousSnapshot.styles) restoreImportedStyle(record);
      this.savedIds = previousIds;
      throw error;
    }
    return { imported: importedIds.length, total: this.savedIds.size };
  }

  async save(id) {
    return (await this.saveMany([id]))[0];
  }

  async saveMany(ids) {
    await this.load();
    const uniqueIds = [...new Set(ids)];
    if (!uniqueIds.length) throw new Error('没有可保存的 Skill');
    const styles = uniqueIds.map(id => getStyle(id));
    if (styles.some(style => !style?.imported || !style.source)) throw new Error('只能保存已导入的网络 Skill');
    const newIds = uniqueIds.filter(id => !this.savedIds.has(id));
    if (this.savedIds.size + newIds.length > MAX_SAVED_STYLES) throw new Error(`本地 Skill 库最多保存 ${MAX_SAVED_STYLES} 条记录`);
    const savedAt = new Date().toISOString();
    for (const [index, id] of uniqueIds.entries()) {
      styles[index].savedAt = styles[index].savedAt || savedAt;
      this.savedIds.add(id);
    }
    try { await this.#enqueueWrite(); }
    catch (error) { for (const id of newIds) this.savedIds.delete(id); throw error; }
    return uniqueIds.map(id => ({ ...getStyleSummary(id), saved: true, savedAt: getStyle(id).savedAt }));
  }

  async remove(id) {
    await this.load();
    if (!this.savedIds.has(id)) return false;
    this.savedIds.delete(id);
    try { await this.#enqueueWrite(); }
    catch (error) { this.savedIds.add(id); throw error; }
    removeImportedStyle(id);
    return true;
  }

  async updateAlias(id, value) {
    await this.load();
    if (!this.savedIds.has(id)) return undefined;
    const previousAlias = getStyle(id)?.alias;
    const updated = setImportedStyleAlias(id, value);
    if (!updated) return undefined;
    try { await this.#enqueueWrite(); }
    catch (error) { setImportedStyleAlias(id, previousAlias); throw error; }
    return { ...getStyleSummary(id), saved: true };
  }

  #enqueueWrite() {
    const next = this.writeQueue.then(() => this.#writeSnapshot());
    this.writeQueue = next.catch(() => {});
    return next;
  }

  async #writeSnapshot() {
    const payload = this.#snapshot();
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    if (!this.recoveredFromBackup) {
      try { await copyFile(this.filePath, `${this.filePath}.bak`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    try {
      await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await rename(temporary, this.filePath);
      this.recoveredFromBackup = false;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  #snapshot() {
    const styles = [...this.savedIds].map(id => {
      const style = getStyle(id);
      if (!style) return undefined;
      return {
        id,
        name: style.name,
        ...(style.alias ? { alias: style.alias } : {}),
        description: style.description,
        prompt: style.prompt,
        source: style.source,
        savedAt: style.savedAt,
        allowText: Boolean(style.allowText)
      };
    }).filter(Boolean);
    return { schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), styles };
  }
}

export const savedStyleLibrary = new SavedStyleLibrary();
