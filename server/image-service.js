import { config } from './config.js';
import { createLogger } from './logger.js';
import { getStyle } from './styles.js';

const TYPES = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
const FORMAT_MIMES = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const RETRYABLE_STATUS = new Set([408, 409, 429]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_START_OF_FRAME = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(buffer) {
  if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) return undefined;
  let offset = 2;
  let dimensions;
  while (offset < buffer.length - 2) {
    if (buffer[offset] !== 0xff) return undefined;
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset];
    offset += 1;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return undefined;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return undefined;
    if (JPEG_START_OF_FRAME.has(marker)) {
      if (length < 7) return undefined;
      dimensions = { width: buffer.readUInt16BE(offset + 5), height: buffer.readUInt16BE(offset + 3) };
    }
    if (marker === 0xda) return dimensions;
    offset += length;
  }
  return undefined;
}

function pngDimensions(buffer) {
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  let offset = 8;
  let dimensions;
  let sawImageData = false;
  let sawEnd = false;
  let chunkIndex = 0;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (!/^[A-Za-z]{4}$/.test(type) || dataEnd + 4 > buffer.length) return undefined;
    if (chunkIndex === 0 && type !== 'IHDR') return undefined;
    if (type === 'IHDR') {
      if (chunkIndex !== 0 || length !== 13 || dimensions) return undefined;
      const width = buffer.readUInt32BE(dataStart);
      const height = buffer.readUInt32BE(dataStart + 4);
      const bitDepth = buffer[dataStart + 8];
      const colorType = buffer[dataStart + 9];
      const validDepths = colorType === 0 ? [1, 2, 4, 8, 16]
        : colorType === 2 ? [8, 16]
          : colorType === 3 ? [1, 2, 4, 8]
            : [4, 6].includes(colorType) ? [8, 16] : [];
      if (!width || !height || !validDepths.includes(bitDepth) || buffer[dataStart + 10] !== 0 || buffer[dataStart + 11] !== 0 || ![0, 1].includes(buffer[dataStart + 12])) return undefined;
      dimensions = { width, height };
    } else if (!dimensions) return undefined;
    if (type === 'IDAT') sawImageData = true;
    offset = dataEnd + 4;
    chunkIndex += 1;
    if (type === 'IEND') {
      if (length !== 0) return undefined;
      sawEnd = true;
      break;
    }
  }
  return dimensions && sawImageData && sawEnd && offset === buffer.length ? dimensions : undefined;
}

function webpDimensions(buffer) {
  if (buffer.length < 25 || buffer.subarray(0, 4).toString() !== 'RIFF' || buffer.subarray(8, 12).toString() !== 'WEBP' || buffer.readUInt32LE(4) + 8 !== buffer.length) return undefined;
  const chunk = buffer.subarray(12, 16).toString();
  const chunkLength = buffer.readUInt32LE(16);
  if (20 + chunkLength + (chunkLength % 2) > buffer.length) return undefined;
  let dimensions;
  if (chunk === 'VP8X' && chunkLength >= 10) dimensions = { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
  if (chunk === 'VP8L' && chunkLength >= 5 && buffer[20] === 0x2f) {
    dimensions = { width: 1 + buffer[21] + ((buffer[22] & 0x3f) << 8), height: 1 + (buffer[22] >> 6) + (buffer[23] << 2) + ((buffer[24] & 0x0f) << 10) };
  }
  if (chunk === 'VP8 ' && chunkLength >= 10 && buffer.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    dimensions = { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
  }
  if (!dimensions?.width || !dimensions?.height) return undefined;
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset + 4);
    offset += 8 + length + (length % 2);
    if (offset > buffer.length) return undefined;
  }
  return offset === buffer.length ? dimensions : undefined;
}

function dimensionsFor(mime, buffer) {
  if (mime === 'image/png') return pngDimensions(buffer);
  if (mime === 'image/jpeg') return jpegDimensions(buffer);
  if (mime === 'image/webp') return webpDimensions(buffer);
  return undefined;
}

function normalizeImageLimits(limits) {
  if (typeof limits === 'number') limits = { maxBytes: limits };
  const selected = limits || {};
  return {
    maxBytes: selected.maxBytes ?? selected.maxImageBytes ?? config.maxImageBytes,
    maxPixels: selected.maxPixels ?? selected.maxImagePixels ?? config.maxImagePixels,
    maxDimension: selected.maxDimension ?? selected.maxImageDimension ?? config.maxImageDimension
  };
}

export function parseImageDataUrl(value, limits) {
  if (typeof value !== 'string') throw new Error('请选择一张图片');
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !TYPES.has(match[1])) throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
  const encoded = match[2];
  if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('图片 Base64 数据无效');
  const normalizedEncoded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.toString('base64') !== normalizedEncoded) throw new Error('图片 Base64 数据无效');
  return parseImageBuffer(match[1], buffer, limits);
}

export function parseImageBuffer(mime, buffer, limits) {
  if (!TYPES.has(mime) || !Buffer.isBuffer(buffer)) throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
  const { maxBytes, maxPixels, maxDimension } = normalizeImageLimits(limits);
  if (!buffer.length || buffer.length > maxBytes) throw new Error(`图片必须小于 ${Math.round(maxBytes / 1048576)} MiB`);
  const validSignature = mime === 'image/png'
    ? buffer.subarray(0, 8).equals(PNG_SIGNATURE)
    : mime === 'image/jpeg'
      ? buffer[0] === 0xff && buffer[1] === 0xd8
      : buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  if (!validSignature) throw new Error('图片内容与声明的格式不匹配');
  const dimensions = dimensionsFor(mime, buffer);
  if (!dimensions?.width || !dimensions?.height) throw new Error('图片文件结构无效或无法读取尺寸');
  if (dimensions.width > maxDimension || dimensions.height > maxDimension) throw new Error(`图片单边尺寸不能超过 ${maxDimension} 像素`);
  if (dimensions.width > Math.floor(maxPixels / dimensions.height)) throw new Error(`图片总像素不能超过 ${maxPixels}`);
  return { mime, ext: TYPES.get(mime), buffer, ...dimensions };
}

function localResult(image, styleId) {
  const filters = {
    watercolor: '<feGaussianBlur stdDeviation="0.55" result="b"/><feColorMatrix in="b" type="saturate" values="1.25"/><feComponentTransfer><feFuncR type="gamma" amplitude="1.08" exponent=".92"/><feFuncG type="gamma" amplitude="1.05" exponent=".95"/><feFuncB type="gamma" amplitude="1.08" exponent=".9"/></feComponentTransfer>',
    cinematic: '<feColorMatrix values=".9 0 .12 0 -.02 0 .92 .08 0 -.02 -.08 .12 1.05 0 .02 0 0 0 1 0"/><feComponentTransfer><feFuncR type="gamma" amplitude="1.12" exponent=".9"/><feFuncB type="gamma" amplitude="1.08" exponent="1.08"/></feComponentTransfer>',
    retro: '<feColorMatrix values="1.05 .08 0 0 .04 .03 .92 .02 0 .02 0 .08 .78 0 .05 0 0 0 1 0"/><feComponentTransfer><feFuncR type="linear" slope=".9" intercept=".08"/><feFuncG type="linear" slope=".88" intercept=".07"/><feFuncB type="linear" slope=".8" intercept=".08"/></feComponentTransfer>',
    ink: '<feColorMatrix type="saturate" values=".12"/><feComponentTransfer><feFuncR type="discrete" tableValues=".08 .22 .48 .74 .95"/><feFuncG type="discrete" tableValues=".07 .2 .45 .72 .94"/><feFuncB type="discrete" tableValues=".06 .18 .4 .69 .92"/></feComponentTransfer>'
  };
  if (!filters[styleId]) {
    const error = new Error('网络 Skill 没有本地滤镜，请使用 Codex 处理方案或配置 OpenAI API');
    error.code = 'DEMO_UNAVAILABLE';
    throw error;
  }
  const href = `data:${image.mime};base64,${image.buffer.toString('base64')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${image.width}" height="${image.height}" viewBox="0 0 ${image.width} ${image.height}"><defs><filter id="f" color-interpolation-filters="sRGB">${filters[styleId]}</filter></defs><rect width="100%" height="100%" fill="#eee9df"/><image href="${href}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" filter="url(#f)"/></svg>`;
  return { image: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`, mode: 'demo', mime: 'image/svg+xml', extension: 'svg', width: image.width, height: image.height, promptTruncated: false };
}

export function buildApiPrompt(style, customPrompt, limit = config.openai.promptMaxChars) {
  const direction = customPrompt.trim() ? ` Additional direction: ${customPrompt.trim()}` : '';
  const typography = style.allowText ? '' : ' Do not add new text unless essential text already exists in the source image.';
  const suffix = `${direction} Preserve the main subject and composition. Do not add signatures, logos, or watermarks.${typography}`;
  const available = Math.max(0, limit - suffix.length);
  const shortened = style.prompt.slice(0, available).trimEnd();
  return { prompt: `${shortened}${suffix}`, truncated: shortened.length < style.prompt.length };
}

function combinedSignal(external, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('AI 图像请求超时')), timeoutMs);
  const abort = () => controller.abort(external.reason);
  if (external) {
    if (external.aborted) abort();
    else external.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() { clearTimeout(timeout); external?.removeEventListener('abort', abort); }
  };
}

function retryDelay(response, attempt) {
  const retryAfter = response?.headers?.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 10_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 10_000);
  }
  return Math.min(500 * 2 ** attempt + Math.floor(Math.random() * 250), 5_000);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason || new Error('请求已取消')); };
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function formFor(runtime, image, prompt) {
  const form = new FormData();
  form.set('model', runtime.openai.model);
  form.set('image[]', new Blob([image.buffer], { type: image.mime }), `upload.${image.ext}`);
  form.set('prompt', prompt);
  form.set('size', runtime.openai.size);
  form.set('quality', runtime.openai.quality);
  form.set('output_format', runtime.openai.outputFormat);
  form.set('input_fidelity', runtime.openai.inputFidelity);
  return form;
}

function invalidResponse(message, status) {
  const error = new Error(message);
  error.code = 'OPENAI_INVALID_RESPONSE';
  error.status = status;
  return error;
}

async function responseText(response, maxBytes) {
  const length = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(length) && length > maxBytes) throw invalidResponse('AI 图像服务响应超过本地安全上限', response.status);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw invalidResponse('AI 图像服务响应超过本地安全上限', response.status);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function responsePayload(response, maxBytes) {
  const raw = await responseText(response, maxBytes);
  if (!raw) return {};
  try { return JSON.parse(raw); }
  catch { throw invalidResponse(`AI 图像服务返回了无法解析的响应（HTTP ${response.status}）`, response.status); }
}

function resultFromPayload(payload, runtime, inputImage) {
  const item = payload.data?.[0];
  const mime = FORMAT_MIMES[runtime.openai.outputFormat];
  if (typeof item?.b64_json === 'string' && item.b64_json) {
    const dataUrl = `data:${mime};base64,${item.b64_json}`;
    let parsed;
    try {
      parsed = parseImageDataUrl(dataUrl, {
        maxBytes: runtime.jobs.maxResultBytes,
        maxPixels: runtime.maxImagePixels,
        maxDimension: runtime.maxImageDimension
      });
    }
    catch { throw invalidResponse('AI 图像服务返回的图片内容或尺寸无效', 200); }
    return { image: dataUrl, mime: parsed.mime, extension: parsed.ext, width: parsed.width, height: parsed.height };
  }
  if (typeof item?.url === 'string') {
    let url;
    try { url = new URL(item.url); } catch { throw invalidResponse('AI 图像服务返回了无效的图片地址', 200); }
    if (url.protocol !== 'https:' || url.username || url.password) throw invalidResponse('AI 图像服务返回了不安全的图片地址', 200);
    return { image: url.href, mime, extension: runtime.openai.outputFormat === 'jpeg' ? 'jpg' : runtime.openai.outputFormat, width: inputImage.width, height: inputImage.height };
  }
  throw invalidResponse('AI 图像服务未返回图片', 200);
}

export function createImageService(runtime = config, { fetchImpl = fetch, logger = createLogger(runtime) } = {}) {
  const status = { configured: Boolean(runtime.openai.apiKey), state: runtime.openai.apiKey ? 'unverified' : 'demo', lastSuccessAt: null, lastError: null };

  async function requestOpenAI(image, prompt, signal) {
    let lastError;
    const responseLimit = Math.ceil(runtime.jobs.maxResultBytes * 4 / 3) + 1024 * 1024;
    for (let attempt = 0; attempt <= runtime.openai.maxRetries; attempt += 1) {
      const combined = combinedSignal(signal, runtime.openai.timeoutMs);
      let response;
      try {
        response = await fetchImpl(runtime.openai.endpoint, {
          method: 'POST',
          headers: { Authorization: `Bearer ${runtime.openai.apiKey}` },
          body: formFor(runtime, image, prompt),
          signal: combined.signal
        });
        const requestId = response.headers.get('x-request-id') || undefined;
        if (!response.ok) {
          let payload;
          try { payload = await responsePayload(response, Math.min(responseLimit, 1024 * 1024)); }
          catch (parseError) {
            const retryable = RETRYABLE_STATUS.has(response.status) || response.status >= 500;
            if (!retryable || attempt >= runtime.openai.maxRetries) throw parseError;
            logger.warn('openai.image_edit_invalid_error_response', { status: response.status, requestId, attempt });
            combined.cleanup(); await wait(retryDelay(response, attempt), signal); continue;
          }
          const error = new Error(payload?.error?.message || `AI 图像服务请求失败（HTTP ${response.status}）`);
          error.code = 'OPENAI_HTTP_ERROR';
          error.status = response.status;
          error.requestId = requestId;
          lastError = error;
          const retryable = RETRYABLE_STATUS.has(response.status) || response.status >= 500;
          logger.warn('openai.image_edit_failed', { status: response.status, requestId, attempt, retryable });
          if (!retryable || attempt >= runtime.openai.maxRetries) throw error;
          combined.cleanup();
          await wait(retryDelay(response, attempt), signal);
          continue;
        }
        const payload = await responsePayload(response, responseLimit);
        logger.info('openai.image_edit_succeeded', { requestId, attempt, model: runtime.openai.model });
        return { payload, requestId };
      } catch (error) {
        if (error.code === 'OPENAI_HTTP_ERROR' || error.code === 'OPENAI_INVALID_RESPONSE') throw error;
        const wrapped = new Error(error.name === 'AbortError' || combined.signal.aborted ? 'AI 图像请求已超时或取消' : `无法连接 AI 图像服务：${error.message}`);
        wrapped.code = combined.signal.aborted ? 'OPENAI_TIMEOUT' : 'OPENAI_CONNECTION_ERROR';
        lastError = wrapped;
        logger.warn('openai.image_edit_connection_error', { attempt, code: wrapped.code });
        if (attempt >= runtime.openai.maxRetries || signal?.aborted) throw wrapped;
        combined.cleanup();
        await wait(retryDelay(undefined, attempt), signal);
      } finally {
        combined.cleanup();
      }
    }
    throw lastError || new Error('AI 图像服务暂时不可用');
  }

  async function stylize({ imageDataUrl, styleId, customPrompt = '', signal }) {
    const style = getStyle(styleId);
    if (!style) throw new Error('未知的风格');
    if (typeof customPrompt !== 'string' || customPrompt.length > 400) throw new Error('创意描述最多 400 个字符');
    const image = parseImageDataUrl(imageDataUrl, runtime);
    if (!runtime.openai.apiKey) return localResult(image, style.filter);
    const built = buildApiPrompt(style, customPrompt, runtime.openai.promptMaxChars);
    try {
      const { payload, requestId } = await requestOpenAI(image, built.prompt, signal);
      const result = resultFromPayload(payload, runtime, image);
      status.state = 'verified'; status.lastSuccessAt = new Date().toISOString(); status.lastError = null;
      return {
        ...result,
        mode: 'openai',
        promptTruncated: built.truncated,
        requestId
      };
    } catch (error) {
      status.state = 'error'; status.lastError = { at: new Date().toISOString(), message: error.message, code: error.code, requestId: error.requestId };
      throw error;
    }
  }

  return {
    stylize,
    getStatus: () => ({ ...status, model: runtime.openai.model })
  };
}

export const imageService = createImageService();
export const stylize = input => imageService.stylize(input);
export const getImageServiceStatus = () => imageService.getStatus();
