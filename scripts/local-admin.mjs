#!/usr/bin/env node
import { mkdir, stat } from 'node:fs/promises';
import { config, publicConfig } from '../server/config.js';
import { CodexJobStore } from '../server/codex-jobs.js';
import { SavedStyleLibrary } from '../server/style-library.js';
import { createLocalBackup } from '../server/local-backup.js';

const [, , command = 'doctor', ...args] = process.argv;
const jsonOutput = args.includes('--json');
const jobs = new CodexJobStore({
  jobsDir: config.paths.jobsDir,
  maxImageBytes: config.maxImageBytes,
  maxResultBytes: config.jobs.maxResultBytes,
  maxImagePixels: config.maxImagePixels,
  maxImageDimension: config.maxImageDimension,
  retentionDays: config.jobs.retentionDays,
  projectRoot: config.projectRoot
});

function output(value) {
  if (jsonOutput) console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

async function pathState(path) {
  try { const info = await stat(path); return { path, exists: true, directory: info.isDirectory(), bytes: info.isFile() ? info.size : undefined }; }
  catch (error) { if (error.code === 'ENOENT') return { path, exists: false }; throw error; }
}

if (command === 'doctor') {
  await mkdir(config.dataDir, { recursive: true });
  const library = new SavedStyleLibrary(config.paths.skillLibraryFile);
  await library.load();
  output({
    ok: true,
    config: publicConfig(config),
    paths: await Promise.all([config.dataDir, config.paths.skillLibraryFile, config.paths.jobsDir, config.paths.backupsDir, config.paths.logFile].map(pathState)),
    usage: await jobs.usage(),
    warnings: library.getWarnings()
  });
} else if (command === 'jobs') {
  const status = args.includes('--pending') ? 'pending' : args.includes('--completed') ? 'completed' : undefined;
  output(await jobs.list({ status }));
} else if (command === 'cleanup') {
  output(await jobs.clearCompleted());
} else if (command === 'prune') {
  output(await jobs.pruneExpired());
} else if (command === 'backup') {
  output(await createLocalBackup(config, { includeImages: args.includes('--include-images') }));
} else {
  console.error('Usage: local-admin.mjs <doctor|jobs|cleanup|prune|backup> [--json] [--pending] [--completed] [--include-images]');
  process.exitCode = 2;
}
