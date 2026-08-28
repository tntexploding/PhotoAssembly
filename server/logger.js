import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function safeDetails(details) {
  if (!details || typeof details !== 'object') return {};
  const copy = { ...details };
  for (const key of Object.keys(copy)) if (/key|token|authorization|image|prompt/i.test(key)) delete copy[key];
  return copy;
}

export function createLogger(runtime, { consoleImpl = console } = {}) {
  let writeQueue = Promise.resolve();
  let lastWriteAt = null;
  let lastError = null;
  const write = (level, event, details = {}) => {
    if (LEVELS[level] > LEVELS[runtime.logLevel]) return;
    const record = { timestamp: new Date().toISOString(), level, event, ...safeDetails(details) };
    const line = `${JSON.stringify(record)}\n`;
    const consoleMethod = level === 'error' ? consoleImpl.error : level === 'warn' ? consoleImpl.warn : consoleImpl.log;
    consoleMethod.call(consoleImpl, `[${level}] ${event}`, safeDetails(details));
    writeQueue = writeQueue.then(async () => {
      await mkdir(dirname(runtime.paths.logFile), { recursive: true });
      await appendFile(runtime.paths.logFile, line, 'utf8');
      lastWriteAt = new Date().toISOString();
      lastError = null;
    }).catch(error => {
      lastError = { at: new Date().toISOString(), code: error.code, message: error.message };
      consoleImpl.error.call(consoleImpl, '[error] logger.write_failed', { path: runtime.paths.logFile, code: error.code, message: error.message });
    });
  };
  const getStatus = () => ({
    state: lastError ? 'error' : 'ready',
    path: runtime.paths.logFile,
    lastWriteAt,
    ...(lastError ? { lastError: { ...lastError } } : {})
  });
  return {
    error: (event, details) => write('error', event, details),
    warn: (event, details) => write('warn', event, details),
    info: (event, details) => write('info', event, details),
    debug: (event, details) => write('debug', event, details),
    getStatus,
    async flush() { await writeQueue; return getStatus(); }
  };
}
