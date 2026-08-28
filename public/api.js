export async function api(path, { method = 'GET', json, signal } = {}) {
  const response = await fetch(path, {
    method,
    ...(json === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }),
    signal
  });
  const type = response.headers.get('content-type') || '';
  let payload;
  if (type.includes('application/json')) payload = await response.json();
  else payload = await response.text();
  if (!response.ok) {
    const message = payload?.error || `请求失败（HTTP ${response.status}）`;
    const details = payload?.upstreamRequestId ? ` · 上游请求 ${payload.upstreamRequestId}` : payload?.requestId ? ` · 本地请求 ${payload.requestId}` : '';
    const error = new Error(`${message}${details}`);
    error.status = response.status;
    error.code = payload?.code;
    throw error;
  }
  return payload;
}

export function downloadJson(payload, filename) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

export function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未知时间' : new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}
