import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importStyleFromUrl, listStyles } from './styles.js';
import { stylize } from './image-service.js';
import { createCodexJob, getCodexJob, getCodexJobResult } from './codex-jobs.js';

const root = join(fileURLToPath(new URL('..', import.meta.url)), 'public');
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const json = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
async function body(req) {
  let raw = ''; for await (const chunk of req) { raw += chunk; if (raw.length > 15_000_000) throw new Error('请求过大'); }
  return JSON.parse(raw || '{}');
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, ai: Boolean(process.env.OPENAI_API_KEY) });
      if (req.method === 'GET' && url.pathname === '/api/styles') return json(res, 200, { styles: listStyles() });
      if (req.method === 'POST' && url.pathname === '/api/styles/import') {
        const input = await body(req);
        return json(res, 201, { style: await importStyleFromUrl(input.url) });
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
