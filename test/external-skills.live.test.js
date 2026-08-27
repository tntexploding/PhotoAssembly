import test from 'node:test';
import assert from 'node:assert/strict';
import { importStyleFromUrl } from '../server/styles.js';
import { createCodexJob } from '../server/codex-jobs.js';
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

const sources = [
  'https://github.com/dacnay816y62-hub/cinema-dna-21x9x3',
  'https://github.com/traveler0621/reality-restaged',
  'https://github.com/2998980-hue/surreal-pop-collage'
];
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+XxG8WQAAAABJRU5ErkJggg==';

test('imports the three supplied GitHub skills from their live repositories', { skip: process.env.RUN_EXTERNAL_SKILL_TESTS !== '1' }, async () => {
  for (const url of sources) {
    const style = await importStyleFromUrl(url);
    assert.ok(style.name); assert.equal(style.source, url); assert.match(style.id, /^remote-/);
    const job = await createCodexJob({ imageDataUrl: png, styleId: style.id });
    try {
      const directory = join('.photoassembly/jobs', job.id); await access(join(directory, 'input.png')); await access(join(directory, 'CODEX_TASK.md'));
      const manifest = JSON.parse(await readFile(join(directory, 'job.json'), 'utf8'));
      assert.equal(manifest.style.source, url); assert.ok(manifest.treatment.primaryPrompt.length >= 10);
    } finally { await rm(join('.photoassembly/jobs', job.id), { recursive: true, force: true }); }
  }
});
