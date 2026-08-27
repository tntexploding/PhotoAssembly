import { getStyle } from './styles.js';

const TYPES = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
const API_PROMPT_LIMIT = 4000;
const API_SAFETY_SUFFIX = ' Preserve the main subject and composition. No text or watermark.';

function buildApiPrompt(stylePrompt, customPrompt) {
  const direction = customPrompt.trim()
    ? ` Additional direction: ${customPrompt.trim()}`
    : '';
  const suffix = `${direction}${API_SAFETY_SUFFIX}`;
  const available = Math.max(0, API_PROMPT_LIMIT - suffix.length);
  return `${stylePrompt.slice(0, available).trimEnd()}${suffix}`;
}

export function parseImageDataUrl(value, maxBytes = 10 * 1024 * 1024) {
  if (typeof value !== 'string') throw new Error('请选择一张图片');
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match || !TYPES.has(match[1])) throw new Error('仅支持 PNG、JPEG 或 WebP 图片');
  const buffer = Buffer.from(match[2], 'base64');
  if (!buffer.length || buffer.length > maxBytes) throw new Error(`图片必须小于 ${Math.round(maxBytes / 1048576)} MiB`);
  return { mime: match[1], ext: TYPES.get(match[1]), buffer };
}

function localResult(image, styleId) {
  const filters = {
    watercolor: '<feGaussianBlur stdDeviation="0.55" result="b"/><feColorMatrix in="b" type="saturate" values="1.25"/><feComponentTransfer><feFuncR type="gamma" amplitude="1.08" exponent=".92"/><feFuncG type="gamma" amplitude="1.05" exponent=".95"/><feFuncB type="gamma" amplitude="1.08" exponent=".9"/></feComponentTransfer>',
    cinematic: '<feColorMatrix values=".9 0 .12 0 -.02 0 .92 .08 0 -.02 -.08 .12 1.05 0 .02 0 0 0 1 0"/><feComponentTransfer><feFuncR type="gamma" amplitude="1.12" exponent=".9"/><feFuncB type="gamma" amplitude="1.08" exponent="1.08"/></feComponentTransfer>',
    retro: '<feColorMatrix values="1.05 .08 0 0 .04 .03 .92 .02 0 .02 0 .08 .78 0 .05 0 0 0 1 0"/><feComponentTransfer><feFuncR type="linear" slope=".9" intercept=".08"/><feFuncG type="linear" slope=".88" intercept=".07"/><feFuncB type="linear" slope=".8" intercept=".08"/></feComponentTransfer>',
    ink: '<feColorMatrix type="saturate" values=".12"/><feComponentTransfer><feFuncR type="discrete" tableValues=".08 .22 .48 .74 .95"/><feFuncG type="discrete" tableValues=".07 .2 .45 .72 .94"/><feFuncB type="discrete" tableValues=".06 .18 .4 .69 .92"/></feComponentTransfer>'
  };
  const href = `data:${image.mime};base64,${image.buffer.toString('base64')}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1200" viewBox="0 0 1200 1200"><defs><filter id="f" color-interpolation-filters="sRGB">${filters[styleId]}</filter></defs><rect width="1200" height="1200" fill="#eee9df"/><image href="${href}" width="1200" height="1200" preserveAspectRatio="xMidYMid slice" filter="url(#f)"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export async function stylize({ imageDataUrl, styleId, customPrompt = '', signal }) {
  const style = getStyle(styleId);
  if (!style) throw new Error('未知的风格');
  if (typeof customPrompt !== 'string' || customPrompt.length > 400) throw new Error('创意描述最多 400 个字符');
  const image = parseImageDataUrl(imageDataUrl, Number(process.env.MAX_IMAGE_BYTES) || 10 * 1024 * 1024);
  if (!process.env.OPENAI_API_KEY) return { image: localResult(image, style.filter || 'watercolor'), mode: 'demo' };

  const form = new FormData();
  form.set('model', process.env.OPENAI_IMAGE_MODEL || 'gpt-image-1.5');
  form.set('image', new Blob([image.buffer], { type: image.mime }), `upload.${image.ext}`);
  form.set('prompt', buildApiPrompt(style.prompt, customPrompt));
  form.set('size', '1024x1024');
  form.set('quality', 'medium');
  const response = await fetch('https://api.openai.com/v1/images/edits', {
    method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: form, signal
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || 'AI 图像服务暂时不可用');
  const item = payload.data?.[0];
  const result = item?.b64_json ? `data:image/png;base64,${item.b64_json}` : item?.url;
  if (!result) throw new Error('AI 图像服务未返回图片');
  return { image: result, mode: 'openai' };
}
