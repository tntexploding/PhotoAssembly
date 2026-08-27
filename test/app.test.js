import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server/index.js';
import { getStyle, isPrivateAddress, listStyles, parseStyleDocument, registerImportedStyle, removeImportedStyle, resolveStyleUrls } from '../server/styles.js';
import { SavedStyleLibrary } from '../server/style-library.js';
import { parseImageDataUrl, stylize } from '../server/image-service.js';
import { createCodexJob, getCodexJob, getCodexJobResult } from '../server/codex-jobs.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxG8WQAAAABJRU5ErkJggg==';

async function createTestLibrary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'photoassembly-skills-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new SavedStyleLibrary(join(directory, 'saved-skills.json'));
}

test('hidden UI states cannot be overridden by component display rules', async () => {
  const css = await readFile(join('public', 'hidden-fix.css'), 'utf8');
  assert.match(css, /\[hidden\]\{display:none!important\}/);
});

test('skill library UI is labeled, keyboard-native and renders remote text safely', async () => {
  const [html, app, css] = await Promise.all([
    readFile(join('public', 'index.html'), 'utf8'),
    readFile(join('public', 'app.js'), 'utf8'),
    readFile(join('public', 'skill-library.css'), 'utf8')
  ]);
  assert.match(html, /id="skill-form"/); assert.match(html, /for="style-url"/); assert.match(html, /aria-live="polite"/);
  assert.match(css, /:focus-visible/); assert.match(css, /saved-skill-alias-form/); assert.match(app, /dataset\.editAlias/); assert.match(app, /method:'PATCH'/);
  assert.match(app, /payload\.styles/); assert.doesNotMatch(app, /\.innerHTML\s*=/);
});

test('style catalog exposes four curated styles', () => {
  assert.equal(listStyles().length, 4);
  assert.deepEqual(listStyles()[0], { id: 'watercolor', name: '清透水彩', description: '半透明颜料、柔和边缘与克制粉彩，适合轻盈自然的照片。', imported: false });
});

test('image validation accepts PNG and rejects unsupported content', () => {
  assert.equal(parseImageDataUrl(onePixelPng).mime, 'image/png');
  assert.throws(() => parseImageDataUrl('data:text/plain;base64,SGk='), /仅支持/);
  assert.throws(() => parseImageDataUrl('data:image/png;base64,SGVsbG8='), /格式不匹配/);
});

test('remote style documents support JSON and Markdown with validation', () => {
  const json = parseStyleDocument('{"name":"霓虹梦境","description":"克制的城市霓虹摄影","prompt":"Use vivid neon light while preserving the subject."}', 'application/json');
  assert.equal(json.name, '霓虹梦境'); assert.equal(json.description, '克制的城市霓虹摄影'); assert.match(json.prompt, /vivid neon/);
  const markdown = parseStyleDocument('# 铅笔速写\nUse expressive graphite hatching and paper texture.');
  assert.equal(markdown.name, '铅笔速写'); assert.match(markdown.prompt, /graphite/);
  assert.throws(() => parseStyleDocument('{}', 'application/json'), /风格名称/);
  assert.throws(() => parseStyleDocument(`# 字节上限\n${'画'.repeat(22_000)}`), /64KB/);
  const longSkill = parseStyleDocument(`# 长篇风格\n${'Keep documentary detail and restrained composition. '.repeat(120)}`);
  assert.ok(longSkill.prompt.length > 4000);
  assert.match(longSkill.prompt, /documentary detail/);
});

test('network imports reject private and reserved destination addresses', () => {
  for (const address of ['0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.31.0.1', '192.0.2.1', '192.168.1.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '::', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', 'ff02::1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPrivateAddress(address), false, address);
});

test('saved Skill library persists descriptions and restores styles after restart', async (t) => {
  const library = await createTestLibrary(t);
  const source = 'https://example.com/editorial-style.md';
  const style = registerImportedStyle(source, { text: '---\nname: editorial-light\ndescription: Restrained editorial lighting with natural texture.\n---\n# Editorial Light\nUse quiet directional light, natural skin texture and documentary detail.', contentType: 'text/markdown' });
  t.after(() => removeImportedStyle(style.id));
  const saved = await library.save(style.id); assert.equal(saved.saved, true); assert.match(saved.description, /Restrained editorial/);
  const aliased = await library.updateAlias(style.id, '纪实柔光'); assert.equal(aliased.alias, '纪实柔光');
  await assert.rejects(library.updateAlias(style.id, '别'.repeat(41)), /不能超过 40/);
  const payload = JSON.parse(await readFile(library.filePath, 'utf8')); assert.equal(payload.styles.length, 1); assert.equal(payload.styles[0].source, source); assert.equal(payload.styles[0].alias, '纪实柔光');
  removeImportedStyle(style.id);
  const restored = new SavedStyleLibrary(library.filePath); await restored.load();
  assert.equal(restored.has(style.id), true); assert.match(getStyle(style.id).description, /Restrained editorial/); assert.equal(getStyle(style.id).alias, '纪实柔光');
  assert.equal((await restored.updateAlias(style.id, '')).alias, undefined);
  const originalPath = restored.filePath; restored.filePath = `${originalPath}.directory`; await mkdir(restored.filePath);
  await assert.rejects(restored.remove(style.id)); assert.equal(restored.has(style.id), true); assert.ok(getStyle(style.id));
  restored.filePath = originalPath;
  assert.equal(await restored.remove(style.id), true); assert.equal(getStyle(style.id), undefined);
});

test('the three supplied GitHub skill formats produce named, detailed treatments', async () => {
  const fixtures = [
    ['cinema-dna.md', 'cinema-dna-21x9x3', /21:9 composition/, 'https://github.com/dacnay816y62-hub/cinema-dna-21x9x3'],
    ['reality-restaged.md', 'reality-restaged', /surreal cinematic tableau/, 'https://github.com/traveler0621/reality-restaged'],
    ['surreal-pop-collage.md', 'surreal-pop-collage', /exactly one impossible giant object/, 'https://github.com/2998980-hue/surreal-pop-collage']
  ];
  for (const [file, name, detail, source] of fixtures) {
    const text = await readFile(join('test/fixtures/external-skills', file), 'utf8');
    const parsed = parseStyleDocument(text, 'text/markdown');
    assert.equal(parsed.name, name); assert.match(parsed.prompt, detail);
    const style = registerImportedStyle(source, { text, contentType: 'text/markdown' });
    const job = await createCodexJob({ imageDataUrl: onePixelPng, styleId: style.id });
    try {
      const directory = join('.photoassembly/jobs', job.id); const manifest = JSON.parse(await readFile(join(directory, 'job.json'), 'utf8'));
      assert.equal(manifest.style.source, source); assert.match(manifest.treatment.primaryPrompt, detail);
      assert.match(await readFile(join(directory, 'CODEX_TASK.md'), 'utf8'), /\$photoassembly-process-job/);
    } finally { removeImportedStyle(style.id); await rm(join('.photoassembly/jobs', job.id), { recursive: true, force: true }); }
  }
  assert.deepEqual(resolveStyleUrls('https://github.com/traveler0621/reality-restaged'), [
    'https://raw.githubusercontent.com/traveler0621/reality-restaged/main/SKILL.md',
    'https://raw.githubusercontent.com/traveler0621/reality-restaged/master/SKILL.md'
  ]);
  const nestedRaw = 'https://raw.githubusercontent.com/Zeejay0/gathered-scenes-zine-skill/main/skills/scenes-gathered-zine-v1-3/SKILL.md';
  assert.deepEqual(resolveStyleUrls('https://github.com/Zeejay0/gathered-scenes-zine-skill/tree/main/skills/scenes-gathered-zine-v1-3'), [nestedRaw]);
  assert.deepEqual(resolveStyleUrls('https://github.com/Zeejay0/gathered-scenes-zine-skill/blob/main/skills/scenes-gathered-zine-v1-3/SKILL.md'), [nestedRaw]);
});

test('demo engine returns a self-contained styled image', async () => {
  const previous = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  const result = await stylize({ imageDataUrl: onePixelPng, styleId: 'ink' });
  assert.equal(result.mode, 'demo'); assert.match(result.image, /^data:image\/svg\+xml;base64,/);
  if (previous) process.env.OPENAI_API_KEY = previous;
});

test('Codex handoff creates a structured pending job without an API key', async (t) => {
  const job = await createCodexJob({ imageDataUrl: onePixelPng, styleId: 'cinematic', customPrompt: 'Keep the expression calm.' });
  const directory = join('.photoassembly/jobs', job.id); const manifestPath = join(directory, 'job.json');
  const candidate = join('.photoassembly', `${job.id}.png`); t.after(() => Promise.all([rm(directory, { recursive: true, force: true }), rm(candidate, { force: true })]));
  assert.equal(job.status, 'pending'); assert.match(job.task, /\$photoassembly-process-job/);
  assert.equal(job.manifest.style.name, '电影夜色'); assert.equal(job.manifest.treatment.invariants.length, 3);
  assert.equal((await getCodexJob(job.id)).hasResult, false);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, status: 'completed', output: '../../secret.png' }));
  await assert.rejects(getCodexJobResult(job.id), /结果文件格式无效/);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  await mkdir('.photoassembly', { recursive: true }); await writeFile(candidate, Buffer.from(onePixelPng.split(',')[1], 'base64'));
  const completed = spawnSync(process.execPath, ['.codex/skills/photoassembly-process-job/scripts/complete-job.mjs', job.id, candidate], { encoding: 'utf8' });
  assert.equal(completed.status, 0, completed.stderr); assert.equal((await getCodexJob(job.id)).status, 'completed');
});

test('HTTP API serves health, styles and rejects unknown styles', async (t) => {
  const styleLibrary = await createTestLibrary(t);
  const server = createServer({ styleLibrary }).listen(0); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const health = await fetch(`${base}/api/health`);
  assert.equal((await health.json()).ok, true);
  assert.match(health.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await (await fetch(`${base}/api/styles`)).json()).styles.length, 4);
  const foreignOrigin = await fetch(`${base}/api/styles/remote-does-not-exist`, { method: 'DELETE', headers: { origin: 'https://example.com' } });
  assert.equal(foreignOrigin.status, 403);
  const unsupportedType = await fetch(`${base}/api/stylize`, { method: 'POST', headers: {'content-type':'text/plain'}, body: '{}' });
  assert.equal(unsupportedType.status, 415);
  const response = await fetch(`${base}/api/stylize`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ imageDataUrl: onePixelPng, styleId: 'missing' }) });
  assert.equal(response.status, 422);
  const created = await fetch(`${base}/api/codex/jobs`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ imageDataUrl: onePixelPng, styleId: 'ink' }) });
  assert.equal(created.status, 201); const codexJob = await created.json(); t.after(() => rm(join('.photoassembly/jobs', codexJob.id), { recursive: true, force: true }));
  assert.equal((await (await fetch(`${base}/api/codex/jobs/${codexJob.id}`)).json()).status, 'pending');
});

test('HTTP API lists and removes a locally saved Skill', async (t) => {
  const styleLibrary = await createTestLibrary(t);
  const style = registerImportedStyle('https://example.com/saved-style.md', { text: '# Saved Style\nUse restrained color, natural texture and a documentary composition.', contentType: 'text/markdown' });
  t.after(() => removeImportedStyle(style.id)); await styleLibrary.save(style.id);
  const server = createServer({ styleLibrary }).listen(0); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const listed = await (await fetch(`${base}/api/styles`)).json();
  assert.equal(listed.styles.find(item => item.id === style.id).saved, true);
  const patched = await fetch(`${base}/api/styles/${style.id}`, { method: 'PATCH', headers: {'content-type':'application/json'}, body: JSON.stringify({ alias: '安静纪实色' }) });
  assert.equal(patched.status, 200); assert.equal((await patched.json()).style.alias, '安静纪实色');
  const afterAlias = await (await fetch(`${base}/api/styles`)).json(); assert.equal(afterAlias.styles.find(item => item.id === style.id).alias, '安静纪实色');
  const removed = await fetch(`${base}/api/styles/${style.id}`, { method: 'DELETE' }); assert.equal(removed.status, 200);
  const after = await (await fetch(`${base}/api/styles`)).json(); assert.equal(after.styles.some(item => item.id === style.id), false);
});

test('HTTP API saves every Skill discovered in one GitHub repository', async (t) => {
  const styleLibrary = await createTestLibrary(t);
  const imported = [];
  const styleImporter = async () => {
    const definitions = [
      ['scenes-gathered-zine-v1-3', 'Preserve truthful photography inside a spacious paper collage.'],
      ['scene-distillation-zine-v1-3', 'Distill the supplied scene into an original editorial illustration.']
    ];
    for (const [name, prompt] of definitions) {
      imported.push(registerImportedStyle(`https://github.com/example/zine/blob/main/skills/${name}/SKILL.md`, {
        text: `---\nname: ${name}\ndescription: ${prompt}\n---\n# ${name}\n${prompt}`,
        contentType: 'text/markdown'
      }));
    }
    return imported;
  };
  t.after(() => imported.forEach(style => removeImportedStyle(style.id)));
  const server = createServer({ styleLibrary, styleImporter }).listen(0); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/styles/import`, {
    method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ url: 'https://github.com/example/zine' })
  });
  assert.equal(response.status, 201);
  const payload = await response.json(); assert.equal(payload.styles.length, 2); assert.equal(payload.style.id, payload.styles[0].id);
  const saved = (await (await fetch(`${base}/api/styles`)).json()).styles.filter(style => style.saved);
  assert.equal(saved.length, 2); assert.deepEqual(saved.map(style => style.name), ['scenes-gathered-zine-v1-3', 'scene-distillation-zine-v1-3']);
});
