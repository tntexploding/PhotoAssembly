import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, publicConfig } from './config.js';
import { CodexJobStore } from './codex-jobs.js';
import { createImageService } from './image-service.js';
import { createLocalBackup } from './local-backup.js';
import { createLogger } from './logger.js';
import { SavedStyleLibrary } from './style-library.js';
import { importStylesFromUrl, listStyles, removeImportedStyle } from './styles.js';

const root = join(fileURLToPath(new URL('..', import.meta.url)), 'public');
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json; charset=utf-8'
};
const securityHeaders = {
  'content-security-policy': "default-src 'self'; img-src 'self' data: https:; connect-src 'self'; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY'
};
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const API_VERSION = 2;

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req, maxBytes) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) {
    const error = new Error('接口仅接受 application/json'); error.code = 'UNSUPPORTED_MEDIA_TYPE'; throw error;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) { const error = new Error(`请求不能超过 ${Math.ceil(maxBytes / 1048576)} MiB`); error.code = 'PAYLOAD_TOO_LARGE'; throw error; }
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function requestHostname(req) {
  const host = String(req.headers.host || '');
  let hostname;
  try { hostname = new URL(`http://${host}`).hostname.toLowerCase(); } catch { hostname = ''; }
  if (!LOOPBACK_HOSTS.has(hostname)) { const error = new Error('拒绝非本机 Host 请求'); error.code = 'FORBIDDEN'; throw error; }
  return host.toLowerCase();
}

function validateOrigin(req) {
  const value = req.headers.origin;
  if (!value) return;
  let origin; try { origin = new URL(value); } catch { origin = undefined; }
  if (!origin || !LOOPBACK_HOSTS.has(origin.hostname.toLowerCase()) || origin.host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) {
    const error = new Error('拒绝非同源写入请求'); error.code = 'FORBIDDEN'; throw error;
  }
}

function statusFor(error) {
  if (error.code === 'ENOENT') return 404;
  if (error.code === 'FORBIDDEN') return 403;
  if (error.code === 'UNSUPPORTED_MEDIA_TYPE') return 415;
  if (error.code === 'PAYLOAD_TOO_LARGE') return 413;
  if (error.code === 'DEMO_UNAVAILABLE') return 409;
  if (error.code === 'OPENAI_TIMEOUT') return 504;
  if (error.code === 'OPENAI_HTTP_ERROR') return error.status === 429 ? 429 : 502;
  if (error.code?.startsWith('OPENAI_')) return 502;
  if (error instanceof SyntaxError) return 400;
  return 422;
}

export function createServer(options = {}) {
  const runtime = options.runtime || config;
  const logger = options.logger || createLogger(runtime);
  const styleLibrary = options.styleLibrary || new SavedStyleLibrary(runtime.paths.skillLibraryFile);
  const styleImporter = options.styleImporter || (url => importStylesFromUrl(url, { runtime }));
  const jobStore = options.jobStore || new CodexJobStore({
    jobsDir: runtime.paths.jobsDir,
    maxImageBytes: runtime.maxImageBytes,
    maxResultBytes: runtime.jobs.maxResultBytes,
    maxImagePixels: runtime.maxImagePixels,
    maxImageDimension: runtime.maxImageDimension,
    retentionDays: runtime.jobs.retentionDays,
    projectRoot: runtime.projectRoot
  });
  const images = options.imageService || createImageService(runtime, { logger });

  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('x-photoassembly-request-id', requestId);
    res.setHeader('x-photoassembly-api-version', String(API_VERSION));
    try {
      for (const [name, value] of Object.entries(securityHeaders)) res.setHeader(name, value);
      requestHostname(req);
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/') && ['POST', 'PATCH', 'DELETE'].includes(req.method)) validateOrigin(req);

      if (req.method === 'GET' && url.pathname === '/api/health') {
        return json(res, 200, {
          ok: true,
          apiVersion: API_VERSION,
          engine: images.getStatus(),
          logging: logger.getStatus?.() || { state: 'unavailable' },
          config: publicConfig(runtime)
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/config') return json(res, 200, publicConfig(runtime));

      if (url.pathname.startsWith('/api/styles')) await styleLibrary.load();
      if (req.method === 'GET' && url.pathname === '/api/styles') {
        const styles = listStyles().map(style => ({ ...style, saved: styleLibrary.has(style.id) }));
        return json(res, 200, { styles, warnings: styleLibrary.getWarnings() });
      }
      if (req.method === 'GET' && url.pathname === '/api/styles/export') return json(res, 200, await styleLibrary.exportSnapshot());
      if (req.method === 'POST' && url.pathname === '/api/styles/import-library') {
        const input = await body(req, runtime.maxRequestBytes);
        return json(res, 200, await styleLibrary.importSnapshot(input.library, { replace: Boolean(input.replace) }));
      }
      if (req.method === 'POST' && url.pathname === '/api/styles/import') {
        const input = await body(req, runtime.maxRequestBytes);
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
      if (req.method === 'PATCH' && styleMatch) {
        const input = await body(req, runtime.maxRequestBytes);
        const style = await styleLibrary.updateAlias(styleMatch[1], input.alias);
        if (!style) return json(res, 404, { error: '未找到已保存的 Skill' });
        return json(res, 200, { style });
      }
      if (req.method === 'DELETE' && styleMatch) {
        if (!await styleLibrary.remove(styleMatch[1])) return json(res, 404, { error: '未找到已保存的 Skill' });
        return json(res, 200, { removed: true, id: styleMatch[1] });
      }

      if (req.method === 'POST' && url.pathname === '/api/stylize') {
        return json(res, 200, await images.stylize({ ...(await body(req, runtime.maxRequestBytes)) }));
      }

      if (req.method === 'GET' && url.pathname === '/api/codex/jobs') {
        const listing = await jobStore.list();
        return json(res, 200, { ...listing, usage: await jobStore.usage() });
      }
      if (req.method === 'DELETE' && url.pathname === '/api/codex/jobs/completed') return json(res, 200, await jobStore.clearCompleted());
      if (req.method === 'POST' && url.pathname === '/api/codex/jobs') return json(res, 201, await jobStore.create(await body(req, runtime.maxRequestBytes)));
      const jobMatch = url.pathname.match(/^\/api\/codex\/jobs\/([a-f0-9-]{36})(\/(?:result|input))?$/);
      if (jobMatch && req.method === 'DELETE' && !jobMatch[2]) {
        if (!await jobStore.delete(jobMatch[1])) return json(res, 404, { error: '任务不存在' });
        return json(res, 200, { removed: true, id: jobMatch[1] });
      }
      if (jobMatch && req.method === 'GET') {
        if (!jobMatch[2]) return json(res, 200, await jobStore.get(jobMatch[1]));
        const image = jobMatch[2] === '/input' ? await jobStore.input(jobMatch[1]) : await jobStore.result(jobMatch[1]);
        res.writeHead(200, { 'content-type': `image/${image.extension === 'jpg' ? 'jpeg' : image.extension}`, 'cache-control': 'no-store' });
        return res.end(image.buffer);
      }

      if (req.method === 'POST' && url.pathname === '/api/local-backup') {
        const input = await body(req, runtime.maxRequestBytes);
        return json(res, 201, await createLocalBackup(runtime, { includeImages: Boolean(input.includeImages) }));
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 404, { error: '未找到接口' });
      const requested = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (requested.includes('..')) return json(res, 403, { error: '禁止访问' });
      const file = await readFile(join(root, requested));
      res.writeHead(200, { 'content-type': types[extname(requested)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      return res.end(req.method === 'HEAD' ? undefined : file);
    } catch (error) {
      const status = statusFor(error);
      logger.error('http.request_failed', { requestId, method: req.method, url: req.url, status, code: error.code, upstreamRequestId: error.requestId });
      if (res.headersSent) return res.destroy();
      return json(res, status, { error: status === 404 ? '页面或任务不存在' : error.message, ...(error.code ? { code: error.code } : {}), ...(error.requestId ? { upstreamRequestId: error.requestId } : {}), requestId });
    }
  });
  server.jobStore = jobStore;
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const logger = createLogger(config);
  const jobStore = new CodexJobStore({
    jobsDir: config.paths.jobsDir,
    maxImageBytes: config.maxImageBytes,
    maxResultBytes: config.jobs.maxResultBytes,
    maxImagePixels: config.maxImagePixels,
    maxImageDimension: config.maxImageDimension,
    retentionDays: config.jobs.retentionDays,
    projectRoot: config.projectRoot
  });
  const pruned = await jobStore.pruneExpired();
  if (pruned.removed) logger.info('jobs.pruned', pruned);
  const server = createServer({ runtime: config, logger, jobStore });
  const displayHost = config.host.includes(':') ? `[${config.host}]` : config.host;
  server.listen(config.port, config.host, () => logger.info('server.started', { url: `http://${displayHost}:${config.port}`, dataDir: config.dataDir }));
  const stop = signal => server.close(() => { logger.info('server.stopped', { signal }); process.exit(0); });
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}
