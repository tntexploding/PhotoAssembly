import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';

export const STYLES = Object.freeze({
  watercolor: {
    name: '清透水彩',
    description: '半透明颜料、柔和边缘与克制粉彩，适合轻盈自然的照片。',
    prompt: 'Transform the photo into a delicate contemporary watercolor painting with translucent pigment washes, textured cold-press paper, soft edges and restrained pastel color. Preserve the subject, identity, composition and important details. No text or watermark.',
    filter: 'watercolor'
  },
  cinematic: {
    name: '电影夜色',
    description: '青绿阴影、暖色高光和自然电影颗粒，营造克制的戏剧感。',
    prompt: 'Create a cinematic editorial photograph with teal shadows, warm highlights, subtle film grain, dramatic but natural lighting and premium color grading. Preserve the subject, identity and composition. No text or watermark.',
    filter: 'cinematic'
  },
  retro: {
    name: '复古胶片',
    description: '暖色褪色、细腻颗粒和轻微光晕，呈现 1970 年代胶片质感。',
    prompt: 'Render as a nostalgic 1970s analog film photograph with warm faded color, fine grain, gentle halation and slightly lifted blacks. Preserve the subject, identity and composition. No text or watermark.',
    filter: 'retro'
  },
  ink: {
    name: '东方墨韵',
    description: '黑墨、矿物色与宣纸呼吸感，保留主体的当代东方表达。',
    prompt: 'Transform into an elegant contemporary Chinese ink-wash artwork using expressive black ink, subtle mineral color accents, rice-paper texture and generous tonal breathing room. Preserve the recognizable subject and composition. No calligraphy, text, seal or watermark.',
    filter: 'ink'
  }
});

const importedStyles = new Map();
const MAX_IMPORTED_PROMPT_CHARS = 60_000;
const MAX_DESCRIPTION_CHARS = 240;
const SAFETY_SUFFIX = ' Preserve the main subject and composition. No text or watermark.';

function normalizeDescription(value, fallback) {
  const candidate = typeof value === 'string' && !/^[>|-]$/.test(value.trim()) ? value : fallback;
  const plain = String(candidate || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`~>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain) return '已保存的网络 Skill，可作为照片处理风格使用。';
  return plain.length > MAX_DESCRIPTION_CHARS ? `${plain.slice(0, MAX_DESCRIPTION_CHARS - 1).trimEnd()}…` : plain;
}

function createImportedStyle({ name, prompt, description }) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) throw new Error('风格名称必须为 1–40 个字符');
  const promptText = typeof prompt === 'string' ? prompt.trim() : '';
  const allowedLength = promptText.endsWith(SAFETY_SUFFIX) ? MAX_IMPORTED_PROMPT_CHARS + SAFETY_SUFFIX.length : MAX_IMPORTED_PROMPT_CHARS;
  if (promptText.length < 10 || promptText.length > allowedLength) throw new Error('风格提示词必须为 10–60000 个字符');
  return {
    name: name.trim(),
    description: normalizeDescription(description, promptText),
    prompt: promptText.endsWith(SAFETY_SUFFIX) ? promptText : `${promptText}${SAFETY_SUFFIX}`,
    filter: 'watercolor',
    imported: true
  };
}

function importedStyleId(source) {
  return `remote-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
}

export function normalizeStyleSource(value) {
  let url; try { url = new URL(value); } catch { throw new Error('请输入有效的 HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('仅允许无凭据的 HTTPS 地址');
  const github = url.hostname.toLowerCase() === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (github) return `https://github.com/${github[1]}/${github[2]}`;
  url.hash = '';
  return url.href;
}

function isPrivateAddress(address) {
  return /^(127\.|10\.|0\.|169\.254\.|192\.168\.|::1$|fc|fd|fe80)/i.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

export function parseStyleDocument(text, contentType = '') {
  if (typeof text !== 'string' || !text.trim()) throw new Error('远程风格文件为空');
  if (Buffer.byteLength(text, 'utf8') > 64_000) throw new Error('远程风格文件不能超过 64KB');
  let name; let prompt; let description;
  if (contentType.includes('json') || text.trimStart().startsWith('{')) {
    let parsed; try { parsed = JSON.parse(text); } catch { throw new Error('远程 JSON 格式无效'); }
    name = parsed.name || parsed.title; prompt = parsed.prompt || parsed.instructions; description = parsed.description || parsed.summary;
  } else {
    const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---\s*/);
    const metadata = {};
    if (frontmatter) for (const line of frontmatter[1].split('\n')) {
      const field = line.match(/^([a-zA-Z][\w-]*):\s*["']?(.+?)["']?\s*$/);
      if (field) metadata[field[1].toLowerCase()] = field[2].replace(/^["']|["']$/g, '');
    }
    const body = frontmatter ? text.slice(frontmatter[0].length) : text;
    const heading = text.match(/^#\s+(.+)$/m);
    name = metadata.name || heading?.[1]?.trim() || '网络风格';
    prompt = body.replace(/^#\s+.+$/m, '').trim() || metadata.description;
    description = metadata.description;
  }
  return createImportedStyle({ name, prompt, description });
}

export function resolveStyleUrls(value) {
  const url = new URL(normalizeStyleSource(value));
  const match = url.hostname === 'github.com' && url.pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!match) return [url.href];
  const [, owner, repository] = match;
  return [
    `https://raw.githubusercontent.com/${owner}/${repository}/main/SKILL.md`,
    `https://raw.githubusercontent.com/${owner}/${repository}/master/SKILL.md`
  ];
}

async function safeFetch(url, redirects = 0) {
  if (redirects > 3) throw new Error('远程地址重定向次数过多');
  let target; try { target = new URL(url); } catch { throw new Error('请输入有效的 HTTPS 地址'); }
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('仅允许无凭据的 HTTPS 地址');
  const allowed = (process.env.STYLE_IMPORT_HOSTS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(target.hostname)) throw new Error('该域名不在 STYLE_IMPORT_HOSTS 允许列表中');
  const addresses = await lookup(target.hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('不允许访问本地或私有网络地址');
  const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { accept: 'application/json, text/markdown, text/plain' } });
  if ([301, 302, 303, 307, 308].includes(response.status)) return safeFetch(new URL(response.headers.get('location'), target).href, redirects + 1);
  if (!response.ok) throw new Error(`下载风格失败（HTTP ${response.status}）`);
  const length = Number(response.headers.get('content-length') || 0);
  if (length > 64_000) throw new Error('远程风格文件不能超过 64KB');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > 64_000) throw new Error('远程风格文件不能超过 64KB');
  return { text, contentType: response.headers.get('content-type') || '' };
}

export function registerImportedStyle(url, document) {
  const source = normalizeStyleSource(url);
  const style = parseStyleDocument(document.text, document.contentType);
  const id = importedStyleId(source);
  importedStyles.set(id, { ...style, source });
  return getStyleSummary(id);
}

export function restoreImportedStyle(record) {
  const source = normalizeStyleSource(record?.source);
  const id = importedStyleId(source);
  if (record?.id && record.id !== id) throw new Error('本地 Skill 标识与来源不匹配');
  const style = createImportedStyle(record || {});
  importedStyles.set(id, { ...style, source, savedAt: record.savedAt });
  return getStyleSummary(id);
}

export function removeImportedStyle(id) { importedStyles.delete(id); }

export async function importStyleFromUrl(url) {
  const source = normalizeStyleSource(url);
  const candidates = resolveStyleUrls(source); let document; let lastError;
  for (const candidate of candidates) {
    try { document = await safeFetch(candidate); break; } catch (error) { lastError = error; }
  }
  if (!document) throw lastError;
  return registerImportedStyle(source, document);
}

export function getStyle(id) { return STYLES[id] || importedStyles.get(id); }

export function getStyleSummary(id) {
  const style = getStyle(id);
  if (!style) return undefined;
  return {
    id,
    name: style.name,
    description: style.description,
    imported: Boolean(style.imported),
    ...(style.source ? { source: style.source } : {}),
    ...(style.savedAt ? { savedAt: style.savedAt } : {})
  };
}

export function listStyles() {
  return [...Object.keys(STYLES), ...importedStyles.keys()].map(getStyleSummary);
}
