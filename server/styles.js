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
const MAX_DISCOVERED_SKILLS = 20;
const MAX_GITHUB_INDEX_BYTES = 1_000_000;
const SAFETY_SUFFIX = ' Preserve the main subject and composition. No text or watermark.';

function normalizeAlias(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error('Skill 别名必须为字符串');
  const alias = value.trim();
  if (!alias) return undefined;
  if (alias.length > 40) throw new Error('Skill 别名不能超过 40 个字符');
  if (/[\u0000-\u001f\u007f]/.test(alias)) throw new Error('Skill 别名不能包含控制字符');
  return alias;
}

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

function createImportedStyle({ name, prompt, description, alias }) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) throw new Error('风格名称必须为 1–40 个字符');
  const promptText = typeof prompt === 'string' ? prompt.trim() : '';
  const allowedLength = promptText.endsWith(SAFETY_SUFFIX) ? MAX_IMPORTED_PROMPT_CHARS + SAFETY_SUFFIX.length : MAX_IMPORTED_PROMPT_CHARS;
  if (promptText.length < 10 || promptText.length > allowedLength) throw new Error('风格提示词必须为 10–60000 个字符');
  const normalizedAlias = normalizeAlias(alias);
  return {
    name: name.trim(),
    description: normalizeDescription(description, promptText),
    prompt: promptText.endsWith(SAFETY_SUFFIX) ? promptText : `${promptText}${SAFETY_SUFFIX}`,
    filter: 'watercolor',
    imported: true,
    ...(normalizedAlias ? { alias: normalizedAlias } : {})
  };
}

function importedStyleId(source) {
  return `remote-${createHash('sha256').update(source).digest('hex').slice(0, 12)}`;
}

function githubLocation(url) {
  if (url.hostname.toLowerCase() !== 'github.com') return undefined;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return undefined;
  const repository = parts[1].replace(/\.git$/i, '');
  if (!parts[0] || !repository) return undefined;
  return {
    owner: parts[0],
    repository,
    action: parts[2]?.toLowerCase(),
    ref: parts[3],
    path: parts.slice(4).join('/')
  };
}

export function normalizeStyleSource(value) {
  let url; try { url = new URL(value); } catch { throw new Error('请输入有效的 HTTPS 地址'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('仅允许无凭据的 HTTPS 地址');
  const github = githubLocation(url);
  if (github && !github.action) return `https://github.com/${github.owner}/${github.repository}`;
  if (github?.action === 'blob' && github.ref && github.path) {
    return `https://github.com/${github.owner}/${github.repository}/blob/${github.ref}/${github.path}`;
  }
  if (github?.action === 'tree' && github.ref && github.path) {
    const path = /(^|\/)SKILL\.md$/i.test(github.path) ? github.path : `${github.path.replace(/\/$/, '')}/SKILL.md`;
    return `https://github.com/${github.owner}/${github.repository}/blob/${github.ref}/${path}`;
  }
  url.hash = '';
  return url.href;
}

export function isPrivateAddress(address) {
  const normalized = String(address).toLowerCase();
  if (normalized === '::' || normalized === '::1' || normalized.startsWith('::ffff:')) return true;
  if (/^(fc|fd|fe[89ab]|ff)/.test(normalized)) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [first, second] = parts;
  return first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && (second === 0 || second === 168)) ||
    (first === 198 && (second === 18 || second === 19 || second === 51)) ||
    (first === 203 && second === 0);
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
  const github = githubLocation(url);
  if (!github) return [url.href];
  if (github.action === 'blob' && github.ref && github.path) {
    return [`https://raw.githubusercontent.com/${github.owner}/${github.repository}/${github.ref}/${github.path}`];
  }
  if (github.action) return [url.href];
  return [
    `https://raw.githubusercontent.com/${github.owner}/${github.repository}/main/SKILL.md`,
    `https://raw.githubusercontent.com/${github.owner}/${github.repository}/master/SKILL.md`
  ];
}

function responseSizeError(maxBytes) {
  return maxBytes === 64_000 ? new Error('远程风格文件不能超过 64KB') : new Error('GitHub 仓库索引过大，无法自动发现 Skill');
}

async function safeFetch(url, { redirects = 0, maxBytes = 64_000, accept = 'application/json, text/markdown, text/plain' } = {}) {
  if (redirects > 3) throw new Error('远程地址重定向次数过多');
  let target; try { target = new URL(url); } catch { throw new Error('请输入有效的 HTTPS 地址'); }
  if (target.protocol !== 'https:' || target.username || target.password) throw new Error('仅允许无凭据的 HTTPS 地址');
  const allowed = (process.env.STYLE_IMPORT_HOSTS || '').split(',').map(v => v.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(target.hostname)) throw new Error('该域名不在 STYLE_IMPORT_HOSTS 允许列表中');
  const addresses = await lookup(target.hostname, { all: true });
  if (!addresses.length || addresses.some(item => isPrivateAddress(item.address))) throw new Error('不允许访问本地或私有网络地址');
  const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { accept, 'user-agent': 'PhotoAssembly/1.0' } });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    return safeFetch(new URL(response.headers.get('location'), target).href, { redirects: redirects + 1, maxBytes, accept });
  }
  if (!response.ok) {
    const error = new Error(`下载风格失败（HTTP ${response.status}）`); error.status = response.status; throw error;
  }
  const length = Number(response.headers.get('content-length') || 0);
  if (length > maxBytes) throw responseSizeError(maxBytes);
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw responseSizeError(maxBytes);
  return { text, contentType: response.headers.get('content-type') || '' };
}

async function discoverGithubSkillSources(source) {
  const github = githubLocation(new URL(source));
  if (!github || github.action) return [];
  const apiBase = `https://api.github.com/repos/${github.owner}/${github.repository}`;
  const metadataDocument = await safeFetch(apiBase, { maxBytes: 256_000, accept: 'application/vnd.github+json' });
  let metadata; try { metadata = JSON.parse(metadataDocument.text); } catch { throw new Error('GitHub 仓库信息格式无效'); }
  if (typeof metadata.default_branch !== 'string' || !metadata.default_branch) throw new Error('无法确定 GitHub 仓库默认分支');
  const treeDocument = await safeFetch(`${apiBase}/git/trees/${encodeURIComponent(metadata.default_branch)}?recursive=1`, {
    maxBytes: MAX_GITHUB_INDEX_BYTES,
    accept: 'application/vnd.github+json'
  });
  let tree; try { tree = JSON.parse(treeDocument.text); } catch { throw new Error('GitHub 仓库索引格式无效'); }
  if (tree.truncated) throw new Error('GitHub 仓库文件过多，请粘贴具体 Skill 文件夹或 SKILL.md 地址');
  const paths = Array.isArray(tree.tree) ? tree.tree
    .filter(item => item?.type === 'blob' && /(^|\/)SKILL\.md$/i.test(item.path || ''))
    .map(item => item.path) : [];
  if (!paths.length) throw new Error('该 GitHub 仓库中未找到 SKILL.md');
  const rootSkill = paths.find(path => path.toLowerCase() === 'skill.md');
  const selected = rootSkill ? [rootSkill] : paths;
  if (selected.length > MAX_DISCOVERED_SKILLS) throw new Error(`一次最多自动导入 ${MAX_DISCOVERED_SKILLS} 个 Skill，请粘贴具体文件夹地址`);
  return selected.map(path => `https://github.com/${github.owner}/${github.repository}/blob/${metadata.default_branch}/${path}`);
}

export function registerImportedStyle(url, document) {
  const source = normalizeStyleSource(url);
  const style = parseStyleDocument(document.text, document.contentType);
  const id = importedStyleId(source);
  const previous = importedStyles.get(id);
  importedStyles.set(id, {
    ...style,
    source,
    ...(previous?.alias ? { alias: previous.alias } : {}),
    ...(previous?.savedAt ? { savedAt: previous.savedAt } : {})
  });
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

export function setImportedStyleAlias(id, value) {
  const style = importedStyles.get(id);
  if (!style) return undefined;
  const alias = normalizeAlias(value);
  if (alias) style.alias = alias;
  else delete style.alias;
  return getStyleSummary(id);
}

export async function importStylesFromUrl(url) {
  const source = normalizeStyleSource(url);
  const candidates = resolveStyleUrls(source); let document; let lastError;
  for (const candidate of candidates) {
    try { document = await safeFetch(candidate); break; } catch (error) { lastError = error; }
  }
  if (document) return [registerImportedStyle(source, document)];
  const discoveredSources = await discoverGithubSkillSources(source);
  if (!discoveredSources.length) throw lastError;
  const documents = await Promise.all(discoveredSources.map(async discoveredSource => {
    const [candidate] = resolveStyleUrls(discoveredSource);
    return { source: discoveredSource, document: await safeFetch(candidate) };
  }));
  return documents.map(item => registerImportedStyle(item.source, item.document));
}

export async function importStyleFromUrl(url) {
  return (await importStylesFromUrl(url))[0];
}

export function getStyle(id) { return STYLES[id] || importedStyles.get(id); }

export function getStyleSummary(id) {
  const style = getStyle(id);
  if (!style) return undefined;
  return {
    id,
    name: style.name,
    ...(style.alias ? { alias: style.alias } : {}),
    description: style.description,
    imported: Boolean(style.imported),
    ...(style.source ? { source: style.source } : {}),
    ...(style.savedAt ? { savedAt: style.savedAt } : {})
  };
}

export function listStyles() {
  return [...Object.keys(STYLES), ...importedStyles.keys()].map(getStyleSummary);
}
