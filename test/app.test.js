import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from '../server/index.js';
import { listStyles, parseStyleDocument, registerImportedStyle, removeImportedStyle, resolveStyleUrls } from '../server/styles.js';
import { parseImageDataUrl, stylize } from '../server/image-service.js';
import { createCodexJob, getCodexJob } from '../server/codex-jobs.js';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const onePixelPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxG8WQAAAABJRU5ErkJggg==';

test('hidden UI states cannot be overridden by component display rules', async () => {
  const css = await readFile(join('public', 'hidden-fix.css'), 'utf8');
  assert.match(css, /\[hidden\]\{display:none!important\}/);
});

test('style catalog exposes four curated styles', () => {
  assert.equal(listStyles().length, 4);
  assert.deepEqual(listStyles()[0], { id: 'watercolor', name: '清透水彩', imported: false });
});

test('image validation accepts PNG and rejects unsupported content', () => {
  assert.equal(parseImageDataUrl(onePixelPng).mime, 'image/png');
  assert.throws(() => parseImageDataUrl('data:text/plain;base64,SGk='), /仅支持/);
});

test('remote style documents support JSON and Markdown with validation', () => {
  const json = parseStyleDocument('{"name":"霓虹梦境","prompt":"Use vivid neon light while preserving the subject."}', 'application/json');
  assert.equal(json.name, '霓虹梦境'); assert.match(json.prompt, /vivid neon/);
  const markdown = parseStyleDocument('# 铅笔速写\nUse expressive graphite hatching and paper texture.');
  assert.equal(markdown.name, '铅笔速写'); assert.match(markdown.prompt, /graphite/);
  assert.throws(() => parseStyleDocument('{}', 'application/json'), /风格名称/);
  const longSkill = parseStyleDocument(`# 长篇风格\n${'Keep documentary detail and restrained composition. '.repeat(120)}`);
  assert.ok(longSkill.prompt.length > 4000);
  assert.match(longSkill.prompt, /documentary detail/);
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
});

test('demo engine returns a self-contained styled image', async () => {
  const previous = process.env.OPENAI_API_KEY; delete process.env.OPENAI_API_KEY;
  const result = await stylize({ imageDataUrl: onePixelPng, styleId: 'ink' });
  assert.equal(result.mode, 'demo'); assert.match(result.image, /^data:image\/svg\+xml;base64,/);
  if (previous) process.env.OPENAI_API_KEY = previous;
});

test('Codex handoff creates a structured pending job without an API key', async (t) => {
  const job = await createCodexJob({ imageDataUrl: onePixelPng, styleId: 'cinematic', customPrompt: 'Keep the expression calm.' });
  const candidate = join('.photoassembly', `${job.id}.png`); t.after(() => Promise.all([rm(join('.photoassembly/jobs', job.id), { recursive: true, force: true }), rm(candidate, { force: true })]));
  assert.equal(job.status, 'pending'); assert.match(job.task, /\$photoassembly-process-job/);
  assert.equal(job.manifest.style.name, '电影夜色'); assert.equal(job.manifest.treatment.invariants.length, 3);
  assert.equal((await getCodexJob(job.id)).hasResult, false);
  await mkdir('.photoassembly', { recursive: true }); await writeFile(candidate, Buffer.from(onePixelPng.split(',')[1], 'base64'));
  const completed = spawnSync(process.execPath, ['.codex/skills/photoassembly-process-job/scripts/complete-job.mjs', job.id, candidate], { encoding: 'utf8' });
  assert.equal(completed.status, 0, completed.stderr); assert.equal((await getCodexJob(job.id)).status, 'completed');
});

test('HTTP API serves health, styles and rejects unknown styles', async (t) => {
  const server = createServer().listen(0); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await (await fetch(`${base}/api/health`)).json()).ok, true);
  assert.equal((await (await fetch(`${base}/api/styles`)).json()).styles.length, 4);
  const response = await fetch(`${base}/api/stylize`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ imageDataUrl: onePixelPng, styleId: 'missing' }) });
  assert.equal(response.status, 422);
  const created = await fetch(`${base}/api/codex/jobs`, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify({ imageDataUrl: onePixelPng, styleId: 'ink' }) });
  assert.equal(created.status, 201); const codexJob = await created.json(); t.after(() => rm(join('.photoassembly/jobs', codexJob.id), { recursive: true, force: true }));
  assert.equal((await (await fetch(`${base}/api/codex/jobs/${codexJob.id}`)).json()).status, 'pending');
});
