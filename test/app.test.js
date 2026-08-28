import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { access, mkdir, mkdtemp, readFile, readdir as fsReaddir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { loadConfig } from '../server/config.js';
import { CodexJobStore } from '../server/codex-jobs.js';
import { buildApiPrompt, createImageService, parseImageDataUrl } from '../server/image-service.js';
import { createServer } from '../server/index.js';
import { createLocalBackup } from '../server/local-backup.js';
import { createLogger } from '../server/logger.js';
import { SavedStyleLibrary } from '../server/style-library.js';
import { createPinnedLookup, fetchStyleDocument, getStyle, isPrivateAddress, listStyles, parseStyleDocument, pinnedHttpsRequest, registerImportedStyle, removeImportedStyle, resolveStyleUrls } from '../server/styles.js';

const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxG8WQAAAABJRU5ErkJggg==';
const onePixelJpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAn/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AKpgA//Z';
const onePixelWebp = 'data:image/webp;base64,UklGRggCAABXRUJQVlA4WAoAAAAgAAAAAAAAAAAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDggGgAAADABAJ0BKgEAAQAAwBIlpAADcAD+/t14AAAA';
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

async function createRuntime(t, env = {}) {
  const projectRoot = await mkdtemp(join(tmpdir(), 'photoassembly-runtime-'));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  return loadConfig({
    projectRoot,
    readLocalFiles: false,
    env: { PHOTOASSEMBLY_DATA_DIR: join(projectRoot, 'data'), STYLE_IMPORT_HOSTS: 'raw.githubusercontent.com,api.github.com', ...env }
  });
}

async function createTestLibrary(t, path) {
  const directory = path || await mkdtemp(join(tmpdir(), 'photoassembly-skills-'));
  if (!path) t.after(() => rm(directory, { recursive: true, force: true }));
  return new SavedStyleLibrary(join(directory, 'saved-skills.json'));
}

test('configuration loads local files, validates values and resolves stable absolute paths', async t => {
  const root = await mkdtemp(join(tmpdir(), 'photoassembly-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, '.env'), 'PORT=3111\nMAX_IMAGE_BYTES=2097152\n');
  await writeFile(join(root, '.env.local'), 'PORT=3222\n');
  await writeFile(join(root, 'config.local.json'), JSON.stringify({ port: 3333, dataDir: 'user-data', openai: { size: 'auto' } }));
  const runtime = loadConfig({ projectRoot: root, env: { PORT: '3444' } });
  assert.equal(runtime.port, 3444); assert.equal(runtime.maxImageBytes, 2 * 1024 * 1024); assert.equal(runtime.dataDir, join(root, 'user-data'));
  assert.equal(runtime.maxImagePixels, 50_000_000); assert.equal(runtime.maxImageDimension, 16_384); assert.equal(runtime.openai.model, 'gpt-image-2');
  assert.ok(isAbsolute(runtime.paths.jobsDir)); assert.deepEqual(runtime.styleImport.allowedHosts, ['raw.githubusercontent.com', 'api.github.com']);
  await writeFile(join(root, 'config.local.json'), await readFile('config.local.example.json', 'utf8'));
  const example = loadConfig({ projectRoot: root, env: {} }); assert.equal(example.port, 3222); assert.equal(example.jobs.maxResultBytes, 25 * 1024 * 1024);
  assert.throws(() => loadConfig({ projectRoot: root, readLocalFiles: false, env: { HOST: '0.0.0.0' } }), /仅允许/);
  assert.throws(() => loadConfig({ projectRoot: root, readLocalFiles: false, env: { PORT: 'nope' } }), /PORT/);
  await writeFile(join(root, 'config.local.json'), JSON.stringify({ openai: { apiKey: 'must-not-live-here' } }));
  assert.throws(() => loadConfig({ projectRoot: root, env: {} }), /不能写入/);
  await writeFile(join(root, 'config.local.json'), JSON.stringify({ poart: 3000 }));
  assert.throws(() => loadConfig({ projectRoot: root, env: {} }), /未知配置/);
});

test('frontend uses local fonts, truthful storage copy and accessible interaction hooks', async () => {
  const [html, app, css, skills] = await Promise.all([
    readFile(join('public', 'index.html'), 'utf8'), readFile(join('public', 'app.js'), 'utf8'),
    readFile(join('public', 'styles.css'), 'utf8'), readFile(join('public', 'skill-library.css'), 'utf8')
  ]);
  assert.match(html, /class="visually-hidden" id="file"/); assert.match(html, /保存到本机数据目录/); assert.match(html, /照片会发送给 OpenAI/); assert.doesNotMatch(html, /YOUR PHOTO IS NOT STORED/);
  assert.doesNotMatch(css, /fonts\.googleapis/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /focus-visible/); assert.match(css, /font-size:\s*\.75rem/);
  assert.match(app, /photoassembly\.lastJobId/); assert.match(app, /REQUIRED_API_VERSION/); assert.match(app, /旧版 PhotoAssembly 服务/); assert.match(app, /payload\.extension/); assert.doesNotMatch(app, /\.download\s*=\s*`[^`]*\.png`/);
  assert.doesNotMatch(skills, /font-size:\s*[89]px/);
});

test('style catalog exposes curated typography policy', () => {
  assert.equal(listStyles().length, 4);
  assert.deepEqual(listStyles()[0], { id: 'watercolor', name: '清透水彩', description: '半透明颜料、柔和边缘与克制粉彩，适合轻盈自然的照片。', imported: false, allowText: false });
});

test('image validation preserves dimensions and rejects unsupported content', () => {
  const image = parseImageDataUrl(onePixelPng); assert.equal(image.mime, 'image/png'); assert.deepEqual([image.width, image.height], [1, 1]);
  for (const [dataUrl, mime] of [[onePixelJpeg, 'image/jpeg'], [onePixelWebp, 'image/webp']]) {
    const parsed = parseImageDataUrl(dataUrl); assert.equal(parsed.mime, mime); assert.deepEqual([parsed.width, parsed.height], [1, 1]);
  }
  assert.throws(() => parseImageDataUrl('data:text/plain;base64,SGk='), /仅支持/);
  assert.throws(() => parseImageDataUrl('data:image/png;base64,SGVsbG8='), /格式不匹配/);
  const truncated = Buffer.from(onePixelPng.split(',')[1], 'base64').subarray(0, 24);
  assert.throws(() => parseImageDataUrl(`data:image/png;base64,${truncated.toString('base64')}`), /结构无效/);
  const oversized = Buffer.from(onePixelPng.split(',')[1], 'base64');
  oversized.writeUInt32BE(100_000, 16); oversized.writeUInt32BE(100_000, 20);
  assert.throws(() => parseImageDataUrl(`data:image/png;base64,${oversized.toString('base64')}`, { maxDimension: 100_000, maxPixels: 50_000_000 }), /总像素/);
  assert.throws(() => parseImageDataUrl(`data:image/png;base64,${oversized.toString('base64')}`, { maxDimension: 16_384, maxPixels: 20_000_000_000 }), /单边尺寸/);
});

test('local preview returns SVG metadata and refuses fake previews for remote Skills', async t => {
  const runtime = await createRuntime(t); const images = createImageService(runtime, { logger: silentLogger });
  const result = await images.stylize({ imageDataUrl: onePixelPng, styleId: 'ink' });
  assert.equal(result.extension, 'svg'); assert.equal(result.mime, 'image/svg+xml'); assert.deepEqual([result.width, result.height], [1, 1]);
  const style = registerImportedStyle('https://example.com/editorial.md', { text: '# Editorial\nUse a precise editorial collage with calm typography.', contentType: 'text/markdown' });
  t.after(() => removeImportedStyle(style.id));
  await assert.rejects(images.stylize({ imageDataUrl: onePixelPng, styleId: style.id }), /没有本地滤镜/);
});

test('API prompt policy preserves typography when the imported Skill allows it', () => {
  const style = { prompt: 'Create a magazine cover with a concise title.', allowText: true };
  const built = buildApiPrompt(style, 'Use warm paper.', 32000);
  assert.match(built.prompt, /magazine cover/); assert.doesNotMatch(built.prompt, /Do not add new text/); assert.equal(built.truncated, false);
  const limited = buildApiPrompt({ prompt: 'x'.repeat(40000), allowText: false }, '', 32000);
  assert.equal(limited.prompt.length, 32000); assert.equal(limited.truncated, true); assert.match(limited.prompt, /Do not add new text/);
});

test('remote style documents support JSON, Markdown and explicit typography metadata', () => {
  const json = parseStyleDocument('{"name":"霓虹梦境","description":"克制的城市霓虹摄影","prompt":"Use vivid neon light while preserving the subject.","allowText":true}', 'application/json');
  assert.equal(json.name, '霓虹梦境'); assert.equal(json.allowText, true); assert.match(json.prompt, /vivid neon/);
  const markdown = parseStyleDocument('---\nallow-text: false\n---\n# 铅笔速写\nUse expressive graphite hatching and paper texture.');
  assert.equal(markdown.allowText, false); assert.match(markdown.prompt, /graphite/);
  assert.throws(() => parseStyleDocument('{}', 'application/json'), /风格名称/);
  assert.throws(() => parseStyleDocument(`# 字节上限\n${'画'.repeat(22_000)}`), /64KB/);
});

test('network imports reject private and reserved destination addresses', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1']) assert.equal(isPrivateAddress(address), true, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(address), false, address);
});

test('remote Skill download pins the validated public address and reports DNS failures clearly', async t => {
  const runtime = await createRuntime(t, { STYLE_IMPORT_HOSTS: 'skills.example', GITHUB_CACHE_TTL_MS: '0' });
  const calls = [];
  const document = await fetchStyleDocument('https://skills.example/SKILL.md', {
    runtime,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async (target, options) => {
      calls.push({ target: target.href, resolved: options.resolved });
      return new Response('# Example\nUse restrained documentary color and preserve the subject.', { status: 200, headers: { 'content-type': 'text/markdown' } });
    }
  });
  assert.equal(document.sourceUrl, 'https://skills.example/SKILL.md');
  assert.deepEqual(calls, [{ target: 'https://skills.example/SKILL.md', resolved: { address: '93.184.216.34', family: 4 } }]);
  const pinned = createPinnedLookup({ address: '93.184.216.34', family: 4 });
  const resolved = await new Promise((resolve, reject) => pinned('skills.example', {}, (error, address, family) => error ? reject(error) : resolve({ address, family })));
  assert.deepEqual(resolved, { address: '93.184.216.34', family: 4 });
  let transportLookup;
  const pinnedResponse = await pinnedHttpsRequest(new URL('https://skills.example/direct.md'), {
    resolved: { address: '93.184.216.34', family: 4 },
    headers: { accept: 'text/plain' },
    signal: AbortSignal.timeout(1_000),
    requestImpl: (_target, options, callback) => {
      assert.equal(options.agent, false);
      options.lookup('skills.example', {}, (error, address, family) => { if (error) throw error; transportLookup = { address, family }; });
      const response = new PassThrough(); response.statusCode = 200; response.headers = { 'content-type': 'text/plain' };
      const request = { once() { return request; }, end() { callback(response); response.end('pinned transport'); } };
      return request;
    }
  });
  assert.deepEqual(transportLookup, { address: '93.184.216.34', family: 4 });
  assert.equal(await new Response(pinnedResponse.body).text(), 'pinned transport');
  await assert.rejects(fetchStyleDocument('https://skills.example/private.md', {
    runtime,
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    transport: async () => { throw new Error('must not connect'); }
  }), /私有或保留/);
  await assert.rejects(fetchStyleDocument('https://skills.example/missing.md', {
    runtime,
    lookupImpl: async () => { const error = new Error('getaddrinfo ENOTFOUND'); error.code = 'ENOTFOUND'; throw error; }
  }), error => error.code === 'STYLE_DNS_ERROR' && /检查网络、DNS 或代理/.test(error.message));
});

test('saved Skill library persists aliases, exports backups and recovers from its .bak file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'photoassembly-library-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const library = await createTestLibrary(t, directory);
  const source = 'https://example.com/editorial-style.md';
  const style = registerImportedStyle(source, { text: '---\nname: editorial-light\ndescription: Restrained editorial lighting.\n---\n# Editorial Light\nUse quiet directional light and documentary detail.', contentType: 'text/markdown' });
  t.after(() => removeImportedStyle(style.id));
  await library.save(style.id); await library.updateAlias(style.id, '纪实柔光');
  const exported = await library.exportSnapshot(); assert.equal(exported.styles[0].alias, '纪实柔光'); assert.equal(exported.styles[0].allowText, true);
  await library.updateAlias(style.id, '第二别名');
  await writeFile(library.filePath, '{broken');
  removeImportedStyle(style.id);
  const recovered = new SavedStyleLibrary(library.filePath); await recovered.load();
  assert.equal(recovered.has(style.id), true); assert.ok(recovered.getWarnings().some(value => value.includes('备份恢复')));
  await recovered.updateAlias(style.id, '恢复后的别名');
  const recoveredMain = await readFile(recovered.filePath, 'utf8'); const recoveredBackup = await readFile(`${recovered.filePath}.bak`, 'utf8');
  assert.doesNotThrow(() => JSON.parse(recoveredMain)); assert.doesNotThrow(() => JSON.parse(recoveredBackup));
  const mergeTarget = await createTestLibrary(t, await mkdtemp(join(tmpdir(), 'photoassembly-import-'))); t.after(() => rm(join(mergeTarget.filePath, '..'), { recursive: true, force: true }));
  const result = await mergeTarget.importSnapshot(exported); assert.equal(result.imported, 1);
});

test('the supplied GitHub Skill formats create isolated Codex jobs', async t => {
  const runtime = await createRuntime(t); const jobs = new CodexJobStore({ jobsDir: runtime.paths.jobsDir, maxImageBytes: runtime.maxImageBytes, projectRoot: runtime.projectRoot });
  const fixtures = [
    ['cinema-dna.md', 'cinema-dna-21x9x3', /21:9 composition/, 'https://github.com/dacnay816y62-hub/cinema-dna-21x9x3'],
    ['reality-restaged.md', 'reality-restaged', /surreal cinematic tableau/, 'https://github.com/traveler0621/reality-restaged'],
    ['surreal-pop-collage.md', 'surreal-pop-collage', /exactly one impossible giant object/, 'https://github.com/2998980-hue/surreal-pop-collage']
  ];
  for (const [fileName, name, detail, source] of fixtures) {
    const text = await readFile(join('test/fixtures/external-skills', fileName), 'utf8'); const parsed = parseStyleDocument(text, 'text/markdown'); assert.equal(parsed.name, name);
    const style = registerImportedStyle(source, { text, contentType: 'text/markdown' });
    try { const job = await jobs.create({ imageDataUrl: onePixelPng, styleId: style.id }); const manifest = JSON.parse(await readFile(join(jobs.directory(job.id), 'job.json'), 'utf8')); assert.match(manifest.treatment.primaryPrompt, detail); assert.equal(manifest.treatment.allowTypography, true); }
    finally { removeImportedStyle(style.id); }
  }
  assert.equal((await jobs.list()).jobs.length, 3);
  assert.deepEqual(resolveStyleUrls('https://github.com/traveler0621/reality-restaged'), ['https://raw.githubusercontent.com/traveler0621/reality-restaged/main/SKILL.md', 'https://raw.githubusercontent.com/traveler0621/reality-restaged/master/SKILL.md']);
  const nestedRaw = 'https://raw.githubusercontent.com/Zeejay0/gathered-scenes-zine-skill/main/skills/scenes-gathered-zine-v1-3/SKILL.md';
  assert.deepEqual(resolveStyleUrls('https://github.com/Zeejay0/gathered-scenes-zine-skill/tree/main/skills/scenes-gathered-zine-v1-3'), [nestedRaw]);
});

test('Codex job lifecycle lists, completes, restores and deletes only temporary test data', async t => {
  const runtime = await createRuntime(t); const jobs = new CodexJobStore({ jobsDir: runtime.paths.jobsDir, maxImageBytes: runtime.maxImageBytes, projectRoot: runtime.projectRoot });
  const job = await jobs.create({ imageDataUrl: onePixelPng, styleId: 'cinematic', customPrompt: 'Keep the expression calm.' });
  const candidate = join(runtime.dataDir, 'candidate.png'); await mkdir(runtime.dataDir, { recursive: true }); await writeFile(candidate, Buffer.from(onePixelPng.split(',')[1], 'base64'));
  assert.equal((await jobs.usage()).pendingCount, 1); assert.equal((await jobs.get(job.id)).task.includes(job.id), true);
  const completed = spawnSync(process.execPath, ['.codex/skills/photoassembly-process-job/scripts/complete-job.mjs', job.id, candidate], {
    encoding: 'utf8', env: { ...process.env, PHOTOASSEMBLY_DATA_DIR: runtime.dataDir, CODEX_JOBS_DIR: runtime.paths.jobsDir, SKILL_LIBRARY_FILE: runtime.paths.skillLibraryFile }
  });
  assert.equal(completed.status, 0, completed.stderr); assert.equal((await jobs.get(job.id)).status, 'completed');
  const resultPath = join(jobs.directory(job.id), 'result.png'); await access(resultPath); assert.ok((await jobs.result(job.id)).buffer.length > 32);
  const malformedResult = Buffer.from(onePixelPng.split(',')[1], 'base64'); malformedResult.writeUInt32BE(100_000, 16); malformedResult.writeUInt32BE(100_000, 20);
  await writeFile(resultPath, malformedResult); await assert.rejects(jobs.result(job.id), /尺寸|像素/);
  const cleared = await jobs.clearCompleted(); assert.equal(cleared.removed, 1); assert.deepEqual(cleared.ids, [job.id]); assert.equal((await jobs.list()).jobs.length, 0);

  const rejectedJob = await jobs.create({ imageDataUrl: onePixelPng, styleId: 'ink' });
  const rejectedCandidate = join(runtime.dataDir, 'oversized.png'); await writeFile(rejectedCandidate, malformedResult);
  const rejected = spawnSync(process.execPath, ['.codex/skills/photoassembly-process-job/scripts/complete-job.mjs', rejectedJob.id, rejectedCandidate], {
    encoding: 'utf8', env: { ...process.env, PHOTOASSEMBLY_DATA_DIR: runtime.dataDir, CODEX_JOBS_DIR: runtime.paths.jobsDir, SKILL_LIBRARY_FILE: runtime.paths.skillLibraryFile }
  });
  assert.notEqual(rejected.status, 0); assert.match(rejected.stderr, /尺寸|像素/); assert.equal((await jobs.get(rejectedJob.id)).status, 'pending'); await jobs.delete(rejectedJob.id);
});

test('OpenAI image wrapper retries 429 responses and records request IDs', async t => {
  const runtime = await createRuntime(t, { OPENAI_API_KEY: 'test-key', OPENAI_MAX_RETRIES: '1', OPENAI_IMAGE_OUTPUT_FORMAT: 'png' });
  let calls = 0;
  const fetchImpl = async (_url, options) => {
    calls += 1;
    assert.equal(options.body.has('image[]'), true); assert.equal(options.body.has('image'), false);
    if (calls === 1) return new Response(JSON.stringify({ error: { message: 'slow down' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '0' } });
    return new Response(JSON.stringify({ data: [{ b64_json: onePixelPng.split(',')[1] }] }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'req_local_test' } });
  };
  const images = createImageService(runtime, { fetchImpl, logger: silentLogger }); const result = await images.stylize({ imageDataUrl: onePixelPng, styleId: 'watercolor' });
  assert.equal(calls, 2); assert.equal(result.requestId, 'req_local_test'); assert.equal(result.extension, 'png'); assert.deepEqual([result.width, result.height], [1, 1]); assert.equal(images.getStatus().state, 'verified');
  const broken = createImageService(runtime, { fetchImpl: async () => new Response(JSON.stringify({ data: [{ b64_json: 'SGVsbG8=' }] }), { status: 200, headers: { 'content-type': 'application/json' } }), logger: silentLogger });
  await assert.rejects(broken.stylize({ imageDataUrl: onePixelPng, styleId: 'watercolor' }), error => error.code === 'OPENAI_INVALID_RESPONSE');
});

test('HTTP API exposes safe config and complete local job management', async t => {
  const runtime = await createRuntime(t); const styleLibrary = new SavedStyleLibrary(runtime.paths.skillLibraryFile); const jobStore = new CodexJobStore({ jobsDir: runtime.paths.jobsDir, maxImageBytes: runtime.maxImageBytes, projectRoot: runtime.projectRoot });
  const healthLogger = { ...silentLogger, getStatus: () => ({ state: 'ready' }) };
  const server = createServer({ runtime, styleLibrary, jobStore, imageService: createImageService(runtime, { logger: silentLogger }), logger: healthLogger }).listen(0); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const healthResponse = await fetch(`${base}/api/health`); const health = await healthResponse.json(); assert.equal(health.apiVersion, 2); assert.equal(healthResponse.headers.get('x-photoassembly-api-version'), '2'); assert.equal(health.engine.state, 'demo'); assert.equal(health.logging.state, 'ready'); assert.equal(health.config.openai.configured, false); assert.equal('apiKey' in health.config.openai, false);
  assert.match(healthResponse.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const reboundStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(`${base}/api/config`, { headers: { host: 'attacker.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
    request.on('error', reject); request.end();
  });
  assert.equal(reboundStatus, 403);
  const created = await (await fetch(`${base}/api/codex/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ imageDataUrl: onePixelPng, styleId: 'ink' }) })).json();
  const listing = await (await fetch(`${base}/api/codex/jobs`)).json(); assert.equal(listing.jobs.length, 1); assert.equal(listing.usage.pendingCount, 1);
  assert.equal((await fetch(`${base}/api/codex/jobs/${created.id}/input`)).status, 200);
  assert.equal((await fetch(`${base}/api/codex/jobs/${created.id}`, { method: 'DELETE' })).status, 200);
  const foreign = await fetch(`${base}/api/styles/remote-does-not-exist`, { method: 'DELETE', headers: { origin: 'https://example.com' } }); assert.equal(foreign.status, 403);
});

test('HTTP API persists aliases and imports every discovered Skill using isolated storage', async t => {
  const runtime = await createRuntime(t); const library = new SavedStyleLibrary(runtime.paths.skillLibraryFile); const imported = [];
  const styleImporter = async () => {
    for (const [name, prompt] of [['scenes-gathered-zine-v1-3', 'Preserve truthful photography inside a spacious paper collage.'], ['scene-distillation-zine-v1-3', 'Distill the scene into an editorial illustration.']]) {
      imported.push(registerImportedStyle(`https://github.com/example/zine/blob/main/skills/${name}/SKILL.md`, { text: `---\nname: ${name}\ndescription: ${prompt}\n---\n# ${name}\n${prompt}`, contentType: 'text/markdown' }));
    }
    return imported;
  };
  t.after(() => imported.forEach(style => removeImportedStyle(style.id)));
  const server = createServer({ runtime, styleLibrary: library, styleImporter, logger: silentLogger }).listen(0); await once(server, 'listening'); t.after(() => server.close()); const base = `http://127.0.0.1:${server.address().port}`;
  const payload = await (await fetch(`${base}/api/styles/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://github.com/example/zine' }) })).json(); assert.equal(payload.styles.length, 2);
  const id = payload.styles[0].id; const alias = await (await fetch(`${base}/api/styles/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ alias: '纸刊实景' }) })).json(); assert.equal(alias.style.alias, '纸刊实景');
  const exported = await (await fetch(`${base}/api/styles/export`)).json(); assert.equal(exported.styles.length, 2);
});

test('local backup excludes secrets and optionally includes job images', async t => {
  const runtime = await createRuntime(t, { OPENAI_API_KEY: 'never-copy-this' }); const jobs = new CodexJobStore({ jobsDir: runtime.paths.jobsDir, maxImageBytes: runtime.maxImageBytes, projectRoot: runtime.projectRoot });
  await jobs.create({ imageDataUrl: onePixelPng, styleId: 'watercolor' });
  const backup = await createLocalBackup(runtime, { includeImages: true }); const manifest = JSON.parse(await readFile(join(backup.directory, 'backup.json'), 'utf8'));
  assert.equal(manifest.includeImages, true); assert.equal(manifest.jobCount, 1); assert.match(manifest.note, /不包含/); assert.equal((await readFile(join(backup.directory, 'backup.json'), 'utf8')).includes('never-copy-this'), false);
  await assert.rejects(createLocalBackup(runtime, {
    readDirectory: async (path, options) => {
      if (path === runtime.paths.jobsDir) return fsReaddir(path, options);
      const error = new Error('permission denied'); error.code = 'EACCES'; throw error;
    }
  }), /无法读取任务目录/);
  const backupEntries = await fsReaddir(runtime.paths.backupsDir);
  assert.equal(backupEntries.some(name => name.endsWith('.tmp')), false);
});

test('logger exposes file write failures without leaking them into an unhandled rejection', async t => {
  const runtime = await createRuntime(t);
  const blocker = join(runtime.dataDir, 'not-a-directory');
  await mkdir(runtime.dataDir, { recursive: true }); await writeFile(blocker, 'blocked');
  const errors = [];
  const logger = createLogger({ ...runtime, paths: { ...runtime.paths, logFile: join(blocker, 'app.log') } }, {
    consoleImpl: { log() {}, warn() {}, error(...args) { errors.push(args); } }
  });
  logger.info('test.log_failure');
  const status = await logger.flush();
  assert.equal(status.state, 'error'); assert.ok(status.lastError?.code); assert.equal(errors.some(args => args[0] === '[error] logger.write_failed'), true);
});
