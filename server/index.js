import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importStylesFromUrl, listStyles, removeImportedStyle } from './styles.js';
import { savedStyleLibrary } from './style-library.js';
import { stylize } from './image-service.js';
import { createCodexJob, getCodexJob, getCodexJobResult } from './codex-jobs.js';

const root = join(fileURLToPath(new URL('..', import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 15_000_000) throw new Error('请求过大'); }
  return JSON.parse(raw || '{}');
}

export function createServer({ styleLibrary = savedStyleLibrary, styleImporter = importStylesFromUrl } = {}) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, ai: Boolean(process.env.OPENAI_API_KEY) });
      if (url.pathname.startsWith('/api/')) await styleLibrary.load();
      if (req.method === 'GET' && url.pathname === '/api/styles') {
        const styles = listStyles().map(style => ({ ...style, saved: styleLibrary.has(style.id) }));
        return json(res, 200, { styles });
      }
      if (req.method === 'POST' && url.pathname === '/api/styles/import') {
        const input = await body(req);
        const imported = await styleImporter(input.url);
        const previouslySaved = new Set(imported.filter(style => styleLibrary.has(style.id)).map(style => style.id));
        try {
          const styles = await styleLibrary.saveMany(imported.map(style => style.id));
          return json(res, 201, { style: styles[0], styles });
        } catch (error) {
          for (const style of imported) if (!previouslySaved.has(style.id)) removeImportedStyle(style.id);
          throw error;
        }
      }
      const styleMatch = url.pathname.match(/^\/api\/styles\/(remote-[a-f0-9]{12})$/);
      if (req.method === 'DELETE' && styleMatch) {
        if (!await styleLibrary.remove(styleMatch[1])) return json(res, 404, { error: '未找到已保存的 Skill' });
        return json(res, 200, { removed: true, id: styleMatch[1] });
      }
      if (req.method === 'POST' && url.pathname === '/api/stylize') {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 120_000);
        try { return json(res, 200, await stylize({ ...(await body(req)), signal: controller.signal })); }
        finally { clearTimeout(timer); }
      }
      if (req.method === 'POST' && url.pathname === '/api/codex/jobs') return json(res, 201, await createCodexJob(await body(req)));
      const jobMatch = url.pathname.match(/^\/api\/codex\/jobs\/([a-f0-9-]{36})(\/result)?$/);
      if (req.method === 'GET' && jobMatch) {
        if (!jobMatch[2]) return json(res, 200, await getCodexJob(jobMatch[1]));
        const result = await getCodexJobResult(jobMatch[1]);
        res.writeHead(200, { 'content-type': `image/${result.extension === 'jpg' ? 'jpeg' : result.extension}`, 'cache-control': 'no-store' }); return res.end(result.buffer);
      }
      if (req.method !== 'GET') return json(res, 404, { error: '未找到接口' });
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (requested.includes('..')) return json(res, 403, { error: '禁止访问' });
      const file = await readFile(join(root, requested));
      res.writeHead(200, { 'content-type': types[extname(requested)] || 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(file);
    } catch (error) {
      const status = error.code === 'ENOENT' ? 404 : error instanceof SyntaxError ? 400 : 422;
      json(res, status, { error: status === 404 ? '页面不存在' : error.message });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(Number(process.env.PORT) || 3000, () => console.log(`光绘已启动：http://localhost:${process.env.PORT || 3000}`));
}
