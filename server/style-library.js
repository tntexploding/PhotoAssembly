import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getStyle, getStyleSummary, removeImportedStyle, restoreImportedStyle } from './styles.js';

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
    await this.load();
    const style = getStyle(id);
    if (!style?.imported || !style.source) throw new Error('只能保存已导入的网络 Skill');
    if (!this.savedIds.has(id) && this.savedIds.size >= MAX_SAVED_STYLES) throw new Error(`本地 Skill 库最多保存 ${MAX_SAVED_STYLES} 条记录`);
    style.savedAt = style.savedAt || new Date().toISOString();
    this.savedIds.add(id);
    await this.#enqueueWrite();
    return { ...getStyleSummary(id), saved: true, savedAt: style.savedAt };
  }

  async remove(id) {
    await this.load();
    if (!this.savedIds.has(id)) return false;
    this.savedIds.delete(id);
    removeImportedStyle(id);
    await this.#enqueueWrite();
    return true;
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
