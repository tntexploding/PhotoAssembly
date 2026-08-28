#!/usr/bin/env node
import { copyFile, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { config } from '../../../../server/config.js';
import { parseImageBuffer } from '../../../../server/image-service.js';

const [, , id, sourceArg] = process.argv;
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id || '') || !sourceArg) {
  console.error('Usage: complete-job.mjs <job-id> <final-image-path>'); process.exit(2);
}
const root = config.paths.jobsDir;
const directory = join(root, id); const source = resolve(sourceArg); const info = await stat(source);
if (!info.isFile() || info.size < 32 || info.size > config.jobs.maxResultBytes) throw new Error(`Result must be a 32B–${Math.round(config.jobs.maxResultBytes / 1048576)}MiB image file`);
const bytes = await readFile(source); let mime;
if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mime = 'image/png';
else if (bytes[0] === 0xff && bytes[1] === 0xd8) mime = 'image/jpeg';
else if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') mime = 'image/webp';
else throw new Error(`Unsupported result format: ${basename(source)}`);
const validated = parseImageBuffer(mime, bytes, {
  maxBytes: config.jobs.maxResultBytes,
  maxPixels: config.maxImagePixels,
  maxDimension: config.maxImageDimension
});
const extension = validated.ext;
const manifestPath = join(directory, 'job.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (manifest.id !== id || manifest.status !== 'pending') throw new Error('Job is missing or no longer pending');
const output = `result.${extension}`; await copyFile(source, join(directory, output));
const updated = { ...manifest, status: 'completed', output, completedAt: new Date().toISOString() };
const temporary = `${manifestPath}.tmp`; await writeFile(temporary, JSON.stringify(updated, null, 2)); await rename(temporary, manifestPath);
console.log(JSON.stringify({ id, status: 'completed', output: join(directory, output) }));
