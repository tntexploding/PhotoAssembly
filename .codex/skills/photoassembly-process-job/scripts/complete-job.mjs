#!/usr/bin/env node
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

const [, , id, sourceArg] = process.argv;
if (!/^[a-f0-9-]{36}$/.test(id || '') || !sourceArg) {
  console.error('Usage: complete-job.mjs <job-id> <final-image-path>'); process.exit(2);
}
const root = resolve(process.env.CODEX_JOBS_DIR || '.photoassembly/jobs');
const directory = join(root, id); const source = resolve(sourceArg); const info = await stat(source);
if (!info.isFile() || info.size < 32 || info.size > 25 * 1024 * 1024) throw new Error('Result must be a 32B–25MB image file');
const bytes = await readFile(source); let extension;
if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) extension = 'png';
else if (bytes[0] === 0xff && bytes[1] === 0xd8) extension = 'jpg';
else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') extension = 'webp';
else throw new Error(`Unsupported result format: ${basename(source)}`);
const manifestPath = join(directory, 'job.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.id !== id || manifest.status !== 'pending') throw new Error('Job is missing or no longer pending');
const output = `result.${extension}`; await copyFile(source, join(directory, output));
const updated = { ...manifest, status: 'completed', output, completedAt: new Date().toISOString() };
const temporary = `${manifestPath}.tmp`; await writeFile(temporary, JSON.stringify(updated, null, 2)); await rename(temporary, manifestPath);
console.log(JSON.stringify({ id, status: 'completed', output: join(directory, output) }));
