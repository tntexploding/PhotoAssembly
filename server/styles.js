import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';

export const STYLES = Object.freeze({
  watercolor: {
    name: '清透水彩',
    prompt: 'Transform the photo into a delicate contemporary watercolor painting with translucent pigment washes, textured cold-press paper, soft edges and restrained pastel color. Preserve the subject, identity, composition and important details. No text or watermark.',
    filter: 'watercolor'
  },
  cinematic: {
    name: '电影夜色',
    prompt: 'Create a cinematic editorial photograph with teal shadows, warm highlights, subtle film grain, dramatic but natural lighting and premium color grading. Preserve the subject, identity and composition. No text or watermark.',
    filter: 'cinematic'
  },
  retro: {
    name: '复古胶片',
    prompt: 'Render as a nostalgic 1970s analog film photograph with warm faded color, fine grain, gentle halation and slightly lifted blacks. Preserve the subject, identity and composition. No text or watermark.',
    filter: 'retro'
  },
  ink: {
    name: '东方墨韵',
    prompt: 'Transform into an elegant contemporary Chinese ink-wash artwork using expressive black ink, subtle mineral color accents, rice-paper texture and generous tonal breathing room. Preserve the recognizable subject and composition. No calligraphy, text, seal or watermark.',
    filter: 'ink'
  }
});

const importedStyles = new Map();
const MAX_IMPORTED_PROMPT_CHARS = 60_000;

function isPrivateAddress(address) {
  return /^(127\.|10\.|0\.|169\.254\.|192\.168\.|::1$|fc|fd|fe80)/i.test(address) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(address);
}

export function parseStyleDocument(text, contentType = '') {
  if (typeof text !== 'string' || !text.trim()) throw new Error('远程风格文件为空');
  if (text.length > 64_000) throw new Error('远程风格文件不能超过 64KB');
  let name; let prompt;
  if (contentType.includes('json') || text.trimStart().startsWith('{')) {
    let parsed; try { parsed = JSON.parse(text); } catch { throw new Error('远程 JSON 格式无效'); }
    name = parsed.name || parsed.title; prompt = parsed.prompt || parsed.instructions;
  } else {
    const frontmatter = text.match(/^---\s*\n([\s\S]*?)\n---\s*/);
    const metadata = {};
    if (frontmatter) for (const line of frontmatter[1].split('\n')) {
      const field = line.match(/^([a-zA-Z][\w-]*):\s*["']?(.+?)["']?\s*$/);
      if (field) metadata[field[1]] = field[2];
    }
    const body = frontmatter ? text.slice(frontmatter[0].length) : text;
    const heading = text.match(/^#\s+(.+)$/m);
    name = metadata.name || heading?.[1]?.trim() || '网络风格';
    prompt = body.replace(/^#\s+.+$/m, '').trim() || metadata.description;
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 40) throw new Error('风格名称必须为 1–40 个字符');
  if (typeof prompt !== 'string' || prompt.trim().length < 10 || prompt.length > MAX_IMPORTED_PROMPT_CHARS) throw new Error('风格提示词必须为 10–60000 个字符');
  return { name: name.trim(), prompt: `${prompt.trim()} Preserve the main subject and composition. No text or watermark.`, filter: 'watercolor', imported: true };
}

export function resolveStyleUrls(value) {
  let url; try { url = new URL(value); } catch { throw new Error('请输入有效的 HTTPS 地址'); }
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
  return { text: await response.text(), contentType: response.headers.get('content-type') || '' };
}

export function registerImportedStyle(url, document) {
  const style = parseStyleDocument(document.text, document.contentType);
  const id = `remote-${createHash('sha256').update(url).digest('hex').slice(0, 12)}`;
  importedStyles.set(id, { ...style, source: url });
  return { id, name: style.name, source: url, imported: true };
}

export function removeImportedStyle(id) { importedStyles.delete(id); }

export async function importStyleFromUrl(url) {
  const candidates = resolveStyleUrls(url); let document; let lastError;
  for (const candidate of candidates) {
    try { document = await safeFetch(candidate); break; } catch (error) { lastError = error; }
  }
  if (!document) throw lastError;
  return registerImportedStyle(url, document);
}

export function getStyle(id) { return STYLES[id] || importedStyles.get(id); }

export function listStyles() {
  return [...Object.entries(STYLES), ...importedStyles.entries()].map(([id, style]) => ({
    id, name: style.name, imported: Boolean(style.imported), ...(style.source ? { source: style.source } : {})
  }));
}
