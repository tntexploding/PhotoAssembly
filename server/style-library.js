import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getStyle, getStyleSummary, removeImportedStyle, restoreImportedStyle, setImportedStyleAlias } from './styles.js';

const SCHEMA_VERSION = 1;
const MAX_SAVED_STYLES = 100;

function defaultLibraryPath() {
  return resolve(process.env.SKILL_LIBRARY_FILE || '.photoassembly/saved-skills.json');
}

export class SavedStyleLibrary {
  constructor(filePath = defaultLibraryPath()) {
    this.filePath = resolve(filePath);
    this.savedIds = new Set();
    this.loaded = false;
    this.loading = null;
    this.writeQueue = Promise.resolve();
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
    try { payload = JSON.parse(raw); } catch { throw new Error('本地 Skill 库文件不是有效的 JSON'); }
    if (payload?.schemaVersion !== SCHEMA_VERSION || !Array.isArray(payload.styles)) throw new Error('本地 Skill 库格式无效');
    for (const record of payload.styles) {
      try {
        const style = restoreImportedStyle(record);
        this.savedIds.add(style.id);
      } catch {
        // 跳过单条损坏记录，避免整个 Skill 库不可用。
      }
    }
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
        savedAt: style.savedAt
      };
    }).filter(Boolean);
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, styles }, null, 2)}\n`, 'utf8');
    await rename(temporary, this.filePath);
  }
}

export const savedStyleLibrary = new SavedStyleLibrary();
