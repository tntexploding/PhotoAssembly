import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseImageDataUrl } from './image-service.js';
import { getStyle } from './styles.js';

const jobsRoot = resolve(process.env.CODEX_JOBS_DIR || '.photoassembly/jobs');
const extensions = new Set(['png', 'jpg', 'webp']);

function jobDirectory(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的任务编号');
  return join(jobsRoot, id);
}

export async function createCodexJob({ imageDataUrl, styleId, customPrompt = '' }) {
  const style = getStyle(styleId);
  if (!style) throw new Error('未知的风格');
  if (typeof customPrompt !== 'string' || customPrompt.length > 400) throw new Error('创意描述最多 400 个字符');
  const image = parseImageDataUrl(imageDataUrl, Number(process.env.MAX_IMAGE_BYTES) || 10 * 1024 * 1024);
  const id = randomUUID(); const directory = jobDirectory(id); const inputName = `input.${image.ext}`;
  await mkdir(directory, { recursive: true });
  const manifest = {
    schemaVersion: 1, id, status: 'pending', createdAt: new Date().toISOString(),
    input: inputName, output: 'result.png', style: { id: styleId, name: style.name, source: style.source || 'built-in' },
    treatment: {
      primaryPrompt: style.prompt,
      customDirection: customPrompt.trim(),
      invariants: ['Preserve the recognizable subject and identity', 'Preserve the original composition unless the direction explicitly requests otherwise', 'Do not add text, signatures, logos, or watermarks'],
      qualityChecklist: ['Subject remains recognizable', 'Requested visual language is clearly present', 'No malformed faces or hands', 'No unwanted text or watermark']
    }
  };
  const task = `# PhotoAssembly Codex 图片任务\n\n任务编号：\`${id}\`\n\n请使用项目 Skill \`$photoassembly-process-job\` 处理此任务。读取 \`${directory}/job.json\` 与输入图片，使用 Codex 的图像能力严格按照格式化方案完成风格化。完成后运行：\n\n\`node .codex/skills/photoassembly-process-job/scripts/complete-job.mjs ${id} <生成图片路径>\`\n`;
  await Promise.all([
    writeFile(join(directory, inputName), image.buffer),
    writeFile(join(directory, 'job.json'), JSON.stringify(manifest, null, 2)),
    writeFile(join(directory, 'CODEX_TASK.md'), task)
  ]);
  return { id, status: 'pending', task, manifest };
}

export async function getCodexJob(id) {
  const directory = jobDirectory(id);
  const manifest = JSON.parse(await readFile(join(directory, 'job.json'), 'utf8'));
  return { ...manifest, hasResult: manifest.status === 'completed' };
}

export async function getCodexJobResult(id) {
  const job = await getCodexJob(id);
  if (!job.hasResult) throw new Error('任务尚未完成');
  const extension = job.output.split('.').pop().toLowerCase();
  if (!extensions.has(extension)) throw new Error('结果文件格式无效');
  return { buffer: await readFile(join(jobDirectory(id), job.output)), extension };
}
