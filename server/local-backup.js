import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { config } from './config.js';

async function copyIfPresent(source, target, files) {
  let info;
  try {
    info = await stat(source);
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!info.isFile()) return false;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
  files.push(target);
  return true;
}

export async function createLocalBackup(runtime = config, { includeImages = false, readDirectory = readdir } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = join(runtime.paths.backupsDir, `${stamp}-${randomUUID().slice(0, 8)}`);
  const working = `${target}.tmp`;
  const files = [];
  await mkdir(runtime.paths.backupsDir, { recursive: true });
  await mkdir(working, { recursive: false });

  try {
    await copyIfPresent(runtime.paths.skillLibraryFile, join(working, 'saved-skills.json'), files);
    await copyIfPresent(`${runtime.paths.skillLibraryFile}.bak`, join(working, 'saved-skills.json.bak'), files);
    await copyIfPresent(runtime.configFile, join(working, 'config.local.json'), files);

    let jobEntries = [];
    try { jobEntries = await readDirectory(runtime.paths.jobsDir, { withFileTypes: true }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    let jobCount = 0;
    for (const entry of jobEntries) {
      if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
      const sourceDirectory = join(runtime.paths.jobsDir, entry.name);
      const targetDirectory = join(working, 'jobs', entry.name);
      let jobFiles;
      try {
        jobFiles = await readDirectory(sourceDirectory, { withFileTypes: true });
      } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw new Error(`无法读取任务目录 ${entry.name}：${error.message}`, { cause: error });
      }
      if (!jobFiles.some(file => file.isFile() && file.name === 'job.json')) throw new Error(`任务目录 ${entry.name} 缺少 job.json，备份已取消`);
      await mkdir(targetDirectory, { recursive: true });
      for (const file of jobFiles) {
        if (!file.isFile()) continue;
        const metadata = ['job.json', 'CODEX_TASK.md'].includes(file.name);
        const image = /^(?:input|result)\.(?:png|jpg|jpeg|webp)$/i.test(file.name);
        if (!metadata && !(includeImages && image)) continue;
        try {
          await copyFile(join(sourceDirectory, file.name), join(targetDirectory, file.name));
          files.push(join(targetDirectory, file.name));
        } catch (error) {
          throw new Error(`无法备份任务 ${entry.name} 的 ${file.name}：${error.message}`, { cause: error });
        }
      }
      jobCount += 1;
    }

    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      sourceDataDir: runtime.dataDir,
      includeImages,
      jobCount,
      fileCount: files.length,
      note: '安全备份不包含 .env、.env.local、OPENAI_API_KEY 或 GITHUB_TOKEN。'
    };
    await writeFile(join(working, 'backup.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await rename(working, target);
    return { directory: target, ...manifest };
  } catch (error) {
    await rm(working, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function readBackupManifest(directory) {
  return JSON.parse(await readFile(join(directory, 'backup.json'), 'utf8'));
}
