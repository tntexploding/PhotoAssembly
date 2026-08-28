import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const IMAGE_SIZES = new Set(['auto', '1024x1024', '1536x1024', '1024x1536']);
const IMAGE_QUALITIES = new Set(['low', 'medium', 'high', 'auto']);
const IMAGE_FORMATS = new Set(['png', 'jpeg', 'webp']);
const INPUT_FIDELITIES = new Set(['low', 'high']);
const SECRET_CONFIG_KEYS = new Set(['apikey', 'token', 'githubtoken', 'secret', 'password', 'credential', 'accesskey', 'accesstoken']);
const LOCAL_CONFIG_SCHEMA = Object.freeze({
  host: true,
  port: true,
  dataDir: true,
  limits: { maxImageBytes: true, maxRequestBytes: true, maxImagePixels: true, maxImageDimension: true },
  paths: { skillLibraryFile: true, jobsDir: true, backupsDir: true, logFile: true },
  openai: { endpoint: true, model: true, size: true, quality: true, outputFormat: true, inputFidelity: true, timeoutMs: true, maxRetries: true, promptMaxChars: true },
  styleImport: { allowedHosts: true, timeoutMs: true, cacheTtlMs: true },
  jobs: { retentionDays: true, maxResultBytes: true },
  logLevel: true,
  importedSkillsAllowText: true
});

function validateLocalConfig(value, schema = LOCAL_CONFIG_SCHEMA, location = 'config.local.json') {
  for (const key of Object.keys(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SECRET_CONFIG_KEYS.has(normalizedKey)) throw new Error(`秘密配置 ${location}.${key} 不能写入 config.local.json，请放入 .env.local 或系统环境变量`);
    if (!Object.hasOwn(schema, key)) throw new Error(`config.local.json 包含未知配置：${location}.${key}`);
    const expected = schema[key];
    if (expected !== true) {
      const nested = value[key];
      if (!nested || typeof nested !== 'object' || Array.isArray(nested)) throw new Error(`${location}.${key} 必须是 JSON 对象`);
      validateLocalConfig(nested, expected, `${location}.${key}`);
    }
  }
}

function parseEnvDocument(text, source) {
  const values = {};
  for (const [index, sourceLine] of text.split(/\r?\n/).entries()) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) throw new Error(`${source}:${index + 1} 不是有效的 KEY=VALUE 配置`);
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    values[match[1]] = value;
  }
  return values;
}

function readEnvFiles(projectRoot) {
  const values = {};
  for (const name of ['.env', '.env.local']) {
    const path = join(projectRoot, name);
    if (existsSync(path)) Object.assign(values, parseEnvDocument(readFileSync(path, 'utf8'), path));
  }
  return values;
}

function readJsonConfig(path) {
  if (!existsSync(path)) return {};
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`本地配置文件不是有效 JSON：${path}（${error.message}）`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`本地配置文件必须是 JSON 对象：${path}`);
  validateLocalConfig(parsed);
  return parsed;
}

function stringValue(value, fallback, name, { allowEmpty = false } = {}) {
  const selected = value === undefined || value === null ? fallback : value;
  if (typeof selected !== 'string') throw new Error(`${name} 必须是字符串`);
  const result = selected.trim();
  if (!allowEmpty && !result) throw new Error(`${name} 不能为空`);
  return result;
}

function integerValue(value, fallback, name, minimum, maximum) {
  const selected = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${name} 必须是 ${minimum}–${maximum} 之间的整数`);
  }
  return selected;
}

function booleanValue(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} 必须是 true 或 false`);
}

function choiceValue(value, fallback, name, choices) {
  const selected = stringValue(value, fallback, name);
  if (!choices.has(selected)) throw new Error(`${name} 必须是以下值之一：${[...choices].join(', ')}`);
  return selected;
}

function pathValue(value, fallback, projectRoot, name) {
  const selected = stringValue(value, fallback, name);
  return resolve(isAbsolute(selected) ? selected : join(projectRoot, selected));
}

function hostList(value, fallback) {
  const items = Array.isArray(value) ? value : String(value ?? fallback).split(',');
  const normalized = [...new Set(items.map(item => String(item).trim().toLowerCase()).filter(Boolean))];
  if (!normalized.length) throw new Error('STYLE_IMPORT_HOSTS 不能为空；使用 * 表示允许任意公网 HTTPS 主机');
  for (const item of normalized) {
    if (item === '*') continue;
    if (!/^(?:\*\.)?[a-z0-9.-]+$/.test(item) || item.includes('..')) throw new Error(`STYLE_IMPORT_HOSTS 包含无效主机：${item}`);
  }
  return Object.freeze(normalized);
}

function pick(env, json, envName, jsonPath, fallback) {
  if (env[envName] !== undefined) return env[envName];
  let value = json;
  for (const part of jsonPath.split('.')) value = value?.[part];
  return value === undefined ? fallback : value;
}

export function loadConfig({ projectRoot = PROJECT_ROOT, env = process.env, readLocalFiles = true } = {}) {
  const normalizedRoot = resolve(projectRoot);
  const fileEnv = readLocalFiles ? readEnvFiles(normalizedRoot) : {};
  const mergedEnv = { ...fileEnv, ...env };
  const configPathSetting = mergedEnv.PHOTOASSEMBLY_CONFIG_FILE || 'config.local.json';
  const configFile = resolve(isAbsolute(configPathSetting) ? configPathSetting : join(normalizedRoot, configPathSetting));
  const local = readLocalFiles ? readJsonConfig(configFile) : {};

  const host = stringValue(pick(mergedEnv, local, 'HOST', 'host', '127.0.0.1'), '127.0.0.1', 'HOST');
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) throw new Error('单机版 HOST 仅允许 127.0.0.1、localhost 或 ::1');
  const port = integerValue(pick(mergedEnv, local, 'PORT', 'port', 3000), 3000, 'PORT', 1, 65535);
  const dataDir = pathValue(pick(mergedEnv, local, 'PHOTOASSEMBLY_DATA_DIR', 'dataDir', '.photoassembly'), '.photoassembly', normalizedRoot, 'PHOTOASSEMBLY_DATA_DIR');
  const maxImageBytes = integerValue(pick(mergedEnv, local, 'MAX_IMAGE_BYTES', 'limits.maxImageBytes', 10 * 1024 * 1024), 10 * 1024 * 1024, 'MAX_IMAGE_BYTES', 1024, 20 * 1024 * 1024);
  const maxImagePixels = integerValue(pick(mergedEnv, local, 'MAX_IMAGE_PIXELS', 'limits.maxImagePixels', 50_000_000), 50_000_000, 'MAX_IMAGE_PIXELS', 1_000_000, 250_000_000);
  const maxImageDimension = integerValue(pick(mergedEnv, local, 'MAX_IMAGE_DIMENSION', 'limits.maxImageDimension', 16_384), 16_384, 'MAX_IMAGE_DIMENSION', 512, 100_000);
  const minimumBodyBytes = Math.ceil(maxImageBytes * 4 / 3) + 1024 * 1024;
  const maxRequestBytes = integerValue(pick(mergedEnv, local, 'MAX_REQUEST_BYTES', 'limits.maxRequestBytes', minimumBodyBytes), minimumBodyBytes, 'MAX_REQUEST_BYTES', minimumBodyBytes, 30 * 1024 * 1024);
  const skillLibraryFile = pathValue(pick(mergedEnv, local, 'SKILL_LIBRARY_FILE', 'paths.skillLibraryFile', join(dataDir, 'saved-skills.json')), join(dataDir, 'saved-skills.json'), normalizedRoot, 'SKILL_LIBRARY_FILE');
  const jobsDir = pathValue(pick(mergedEnv, local, 'CODEX_JOBS_DIR', 'paths.jobsDir', join(dataDir, 'jobs')), join(dataDir, 'jobs'), normalizedRoot, 'CODEX_JOBS_DIR');
  const backupsDir = pathValue(pick(mergedEnv, local, 'PHOTOASSEMBLY_BACKUPS_DIR', 'paths.backupsDir', join(dataDir, 'backups')), join(dataDir, 'backups'), normalizedRoot, 'PHOTOASSEMBLY_BACKUPS_DIR');
  const logFile = pathValue(pick(mergedEnv, local, 'PHOTOASSEMBLY_LOG_FILE', 'paths.logFile', join(dataDir, 'logs', 'app.log')), join(dataDir, 'logs', 'app.log'), normalizedRoot, 'PHOTOASSEMBLY_LOG_FILE');

  const endpoint = stringValue(pick(mergedEnv, local, 'OPENAI_API_URL', 'openai.endpoint', 'https://api.openai.com/v1/images/edits'), 'https://api.openai.com/v1/images/edits', 'OPENAI_API_URL');
  let endpointUrl;
  try { endpointUrl = new URL(endpoint); } catch { throw new Error('OPENAI_API_URL 必须是有效 URL'); }
  if (endpointUrl.protocol !== 'https:') throw new Error('OPENAI_API_URL 必须使用 HTTPS');

  const imageSize = choiceValue(pick(mergedEnv, local, 'OPENAI_IMAGE_SIZE', 'openai.size', 'auto'), 'auto', 'OPENAI_IMAGE_SIZE', IMAGE_SIZES);
  const imageQuality = choiceValue(pick(mergedEnv, local, 'OPENAI_IMAGE_QUALITY', 'openai.quality', 'medium'), 'medium', 'OPENAI_IMAGE_QUALITY', IMAGE_QUALITIES);
  const outputFormat = choiceValue(pick(mergedEnv, local, 'OPENAI_IMAGE_OUTPUT_FORMAT', 'openai.outputFormat', 'png'), 'png', 'OPENAI_IMAGE_OUTPUT_FORMAT', IMAGE_FORMATS);
  const inputFidelity = choiceValue(pick(mergedEnv, local, 'OPENAI_IMAGE_INPUT_FIDELITY', 'openai.inputFidelity', 'high'), 'high', 'OPENAI_IMAGE_INPUT_FIDELITY', INPUT_FIDELITIES);

  const runtime = {
    projectRoot: normalizedRoot,
    configFile,
    host,
    port,
    dataDir,
    maxImageBytes,
    maxImagePixels,
    maxImageDimension,
    maxRequestBytes,
    paths: Object.freeze({ skillLibraryFile, jobsDir, backupsDir, logFile }),
    openai: Object.freeze({
      apiKey: stringValue(mergedEnv.OPENAI_API_KEY, '', 'OPENAI_API_KEY', { allowEmpty: true }),
      endpoint: endpointUrl.href,
      model: stringValue(pick(mergedEnv, local, 'OPENAI_IMAGE_MODEL', 'openai.model', 'gpt-image-2'), 'gpt-image-2', 'OPENAI_IMAGE_MODEL'),
      size: imageSize,
      quality: imageQuality,
      outputFormat,
      inputFidelity,
      timeoutMs: integerValue(pick(mergedEnv, local, 'OPENAI_TIMEOUT_MS', 'openai.timeoutMs', 120_000), 120_000, 'OPENAI_TIMEOUT_MS', 1_000, 10 * 60_000),
      maxRetries: integerValue(pick(mergedEnv, local, 'OPENAI_MAX_RETRIES', 'openai.maxRetries', 2), 2, 'OPENAI_MAX_RETRIES', 0, 5),
      promptMaxChars: integerValue(pick(mergedEnv, local, 'OPENAI_PROMPT_MAX_CHARS', 'openai.promptMaxChars', 32_000), 32_000, 'OPENAI_PROMPT_MAX_CHARS', 1_000, 32_000)
    }),
    styleImport: Object.freeze({
      allowedHosts: hostList(pick(mergedEnv, local, 'STYLE_IMPORT_HOSTS', 'styleImport.allowedHosts', ['raw.githubusercontent.com', 'api.github.com']), 'raw.githubusercontent.com,api.github.com'),
      timeoutMs: integerValue(pick(mergedEnv, local, 'STYLE_IMPORT_TIMEOUT_MS', 'styleImport.timeoutMs', 15_000), 15_000, 'STYLE_IMPORT_TIMEOUT_MS', 1_000, 120_000),
      cacheTtlMs: integerValue(pick(mergedEnv, local, 'GITHUB_CACHE_TTL_MS', 'styleImport.cacheTtlMs', 300_000), 300_000, 'GITHUB_CACHE_TTL_MS', 0, 24 * 60 * 60_000),
      githubToken: stringValue(mergedEnv.GITHUB_TOKEN, '', 'GITHUB_TOKEN', { allowEmpty: true })
    }),
    jobs: Object.freeze({
      retentionDays: integerValue(pick(mergedEnv, local, 'JOB_RETENTION_DAYS', 'jobs.retentionDays', 0), 0, 'JOB_RETENTION_DAYS', 0, 3650),
      maxResultBytes: integerValue(pick(mergedEnv, local, 'MAX_RESULT_BYTES', 'jobs.maxResultBytes', 25 * 1024 * 1024), 25 * 1024 * 1024, 'MAX_RESULT_BYTES', 1024, 50 * 1024 * 1024)
    }),
    logLevel: choiceValue(pick(mergedEnv, local, 'PHOTOASSEMBLY_LOG_LEVEL', 'logLevel', 'info'), 'info', 'PHOTOASSEMBLY_LOG_LEVEL', new Set(['error', 'warn', 'info', 'debug'])),
    importedSkillsAllowText: booleanValue(pick(mergedEnv, local, 'IMPORTED_SKILLS_ALLOW_TEXT', 'importedSkillsAllowText', true), true, 'IMPORTED_SKILLS_ALLOW_TEXT')
  };
  return Object.freeze(runtime);
}

export function publicConfig(runtime) {
  return {
    host: runtime.host,
    port: runtime.port,
    dataDir: runtime.dataDir,
    maxImageBytes: runtime.maxImageBytes,
    maxImagePixels: runtime.maxImagePixels,
    maxImageDimension: runtime.maxImageDimension,
    openai: {
      configured: Boolean(runtime.openai.apiKey),
      model: runtime.openai.model,
      size: runtime.openai.size,
      quality: runtime.openai.quality,
      outputFormat: runtime.openai.outputFormat,
      timeoutMs: runtime.openai.timeoutMs,
      maxRetries: runtime.openai.maxRetries
    },
    styleImport: {
      allowedHosts: runtime.styleImport.allowedHosts,
      githubTokenConfigured: Boolean(runtime.styleImport.githubToken),
      cacheTtlMs: runtime.styleImport.cacheTtlMs
    },
    jobs: { retentionDays: runtime.jobs.retentionDays }
  };
}

export const config = loadConfig();
