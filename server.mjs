import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildMealRequest,
  calculateTotals,
  callGemini,
  GeminiRequestError,
  readConfig,
} from './analyze-nutrition.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 55_000_000;
const MAX_IMAGES = 30;
const MAX_IMAGES_PER_MEAL = 10;
const MAX_IMAGE_BYTES = 14_000_000;
const MAX_TOTAL_IMAGE_BYTES = 35_000_000;
const MAX_NOTE_CHARACTERS = 2_000;
const MAX_FILENAME_CHARACTERS = 120;
const MAX_ANALYSIS_CACHE_ENTRIES = 100;
const ANALYSIS_CACHE_VERSION = 7;
const HISTORY_RECORD_VERSION = 1;
const HISTORY_DIRECTORY = 'history';
const CLIENT_API_KEY_HEADER = 'x-gemini-api-key';
const MOBILE_APP_ORIGINS = new Set(['capacitor://localhost', 'https://localhost', 'http://localhost']);
const SUPPORTED_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);
const MEAL_DEFINITIONS = Object.freeze([
  { id: 'breakfast', label: '早餐' },
  { id: 'lunch', label: '午餐' },
  { id: 'afternoon_tea', label: '下午茶' },
  { id: 'dinner', label: '晚餐' },
  { id: 'late_night', label: '宵夜' },
  { id: 'meal', label: '餐點' },
]);
const MEAL_LABELS = new Map(MEAL_DEFINITIONS.map(meal => [meal.id, meal.label]));

const STATIC_FILES = new Map([
  ['/', { filename: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/index.html', { filename: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/styles.css', { filename: 'styles.css', contentType: 'text/css; charset=utf-8' }],
  ['/app.js', { filename: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/app.bundle.js', { filename: 'app.bundle.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/manifest.webmanifest', { filename: 'manifest.webmanifest', contentType: 'application/manifest+json; charset=utf-8' }],
  ['/app-icon.svg', { filename: 'app-icon.svg', contentType: 'image/svg+xml' }],
  ['/service-worker.js', { filename: 'service-worker.js', contentType: 'text/javascript; charset=utf-8' }],
]);

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': "default-src 'self'; base-uri 'none'; connect-src 'self' https://generativelanguage.googleapis.com; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' blob: data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(self)',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
});

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
  }
}

function logWith(logger, level, message) {
  if (typeof logger === 'function') {
    logger(message);
    return;
  }
  const method = logger?.[level] ?? (level === 'log' ? logger?.info : undefined) ?? logger?.log;
  if (typeof method === 'function') method.call(logger, message);
}

function redactedMessage(error, apiKey = '') {
  let message = error instanceof Error ? error.message : String(error);
  if (apiKey) message = message.replaceAll(apiKey, '[REDACTED]');
  return message.replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 500);
}

function applyMobileCors(request, response) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !MOBILE_APP_ORIGINS.has(origin)) return false;
  response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Gemini-Api-Key, X-Nutrition-History');
  response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, PUT, DELETE, OPTIONS');
  response.setHeader('Access-Control-Max-Age', '600');
  response.setHeader('Vary', 'Origin');
  return true;
}

function readClientApiKey(request) {
  const value = request.headers[CLIENT_API_KEY_HEADER];
  if (value === undefined) return '';
  if (Array.isArray(value)) throw new RequestError(400, 'API key 標頭格式錯誤。');
  const apiKey = value.trim();
  if (apiKey.length < 20 || apiKey.length > 500 || /[\x00-\x20\x7f]/.test(apiKey)) {
    throw new RequestError(400, 'Google AI Studio API key 格式錯誤。');
  }
  return apiKey;
}

function createAnalysisCacheKey(images, mealType, mealNote, splitItems, configuration) {
  const metadata = JSON.stringify({
    version: ANALYSIS_CACHE_VERSION,
    images: images.map(image => ({ name: image.name, mimeType: image.mimeType })),
    mealNote,
    mealType,
    splitItems,
    prompt: configuration.prompt,
    models: configuration.models,
    apiKeyScope: createHash('sha256').update(configuration.apiKey, 'utf8').digest('hex'),
  });
  const hash = createHash('sha256').update(metadata, 'utf8');
  for (const image of images) hash.update('\0').update(image.bytes);
  return hash.digest('hex');
}

function readAnalysisCache(cache, key) {
  const entry = cache.get(key);
  if (!entry) return null;
  // Move a hit to the end so the bounded Map behaves as a small LRU cache.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function writeAnalysisCache(cache, key, entry) {
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_ANALYSIS_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

function sendBuffer(response, status, contentType, body, { head = false, cacheControl = 'no-store', extraHeaders = {} } = {}) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Cache-Control': cacheControl,
    'Content-Length': bytes.byteLength,
    'Content-Type': contentType,
    ...extraHeaders,
  });
  response.end(head ? undefined : bytes);
}

function sendJson(response, status, value, { head = false, extraHeaders = {} } = {}) {
  sendBuffer(response, status, 'application/json; charset=utf-8', JSON.stringify(value), { head, extraHeaders });
}

function fail(response, status, message, options) {
  sendJson(response, status, { error: message }, options);
}

function methodNotAllowed(response, allowed, head = false) {
  fail(response, 405, '此網址不支援這個 HTTP 方法。', {
    head,
    extraHeaders: { Allow: allowed.join(', ') },
  });
}

async function readRequestBody(request) {
  const declaredLength = request.headers['content-length'];
  if (declaredLength !== undefined) {
    if (!/^\d+$/.test(declaredLength)) throw new RequestError(400, 'Content-Length 格式錯誤。');
    if (Number(declaredLength) > MAX_BODY_BYTES) {
      request.resume();
      throw new RequestError(413, '上傳內容過大；請縮小照片後再試。');
    }
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;

    const rejectOnce = error => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.on('data', chunk => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.byteLength;
      if (length > MAX_BODY_BYTES) {
        chunks.length = 0;
        request.resume();
        rejectOnce(new RequestError(413, '上傳內容過大；請縮小照片後再試。'));
        return;
      }
      chunks.push(bytes);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, length));
    });
    request.on('aborted', () => rejectOnce(new RequestError(400, '上傳在完成前中斷。')));
    request.on('error', () => rejectOnce(new RequestError(400, '無法讀取上傳內容。')));
  });
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value, allowed, label) {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor' || !allowedSet.has(key)) {
      throw new RequestError(400, `${label}包含不支援的欄位。`);
    }
  }
}

function characterCountWithin(value, maximum) {
  // The UTF-16 length check avoids expanding an unexpectedly large string first.
  return value.length <= maximum * 2 && Array.from(value).length <= maximum;
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function validateDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RequestError(400, 'date 必須是 YYYY-MM-DD 格式。');
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new RequestError(400, 'date 不是有效日期。');
  }
  return value;
}

function validateFilename(value, index) {
  if (typeof value !== 'string' || value.length === 0 || !characterCountWithin(value, MAX_FILENAME_CHARACTERS)) {
    throw new RequestError(400, `第 ${index + 1} 張照片的檔名必須是 1–${MAX_FILENAME_CHARACTERS} 個字元。`);
  }
  if (value !== value.trim() || value === '.' || value === '..'
    || /[\x00-\x1f\x7f<>:"/\\|?*]/u.test(value)
    || path.posix.basename(value) !== value || path.win32.basename(value) !== value) {
    throw new RequestError(400, `第 ${index + 1} 張照片的檔名不安全。`);
  }
  return value;
}

function decodeBase64(value, index) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RequestError(400, `第 ${index + 1} 張照片缺少影像資料。`);
  }
  if (value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new RequestError(400, `第 ${index + 1} 張照片不是有效的 Base64 資料。`);
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const decodedLength = (value.length / 4) * 3 - padding;
  if (decodedLength === 0) throw new RequestError(400, `第 ${index + 1} 張照片是空檔案。`);
  if (decodedLength > MAX_IMAGE_BYTES) {
    throw new RequestError(413, `第 ${index + 1} 張照片超過 14 MB，請先縮小照片。`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength !== decodedLength || bytes.toString('base64') !== value) {
    throw new RequestError(400, `第 ${index + 1} 張照片不是有效的 Base64 資料。`);
  }
  return bytes;
}

function hasExpectedImageSignature(bytes, mimeType) {
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mimeType === 'image/webp') {
    return bytes.length >= 12
      && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
      && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (mimeType === 'image/heic' || mimeType === 'image/heif') {
    if (bytes.length < 12 || bytes.subarray(4, 8).toString('ascii') !== 'ftyp') return false;
    const brands = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
    for (let offset = 8; offset + 4 <= Math.min(bytes.length, 48); offset += 4) {
      if (brands.has(bytes.subarray(offset, offset + 4).toString('ascii'))) return true;
    }
  }
  return false;
}

function validatePayload(value, { allowEmpty = false } = {}) {
  if (!isPlainRecord(value)) throw new RequestError(400, 'JSON 最外層必須是物件。');
  assertOnlyKeys(value, ['images', 'date', 'mealNotes', 'force', 'splitItems'], 'JSON ');
  if (value.force !== undefined && typeof value.force !== 'boolean') {
    throw new RequestError(400, 'force 必須是布林值。');
  }
  if (value.splitItems !== undefined && typeof value.splitItems !== 'boolean') {
    throw new RequestError(400, 'splitItems 必須是布林值。');
  }
  if (!Object.hasOwn(value, 'images') || !Array.isArray(value.images)) {
    throw new RequestError(400, 'images 必須是陣列。');
  }
  if (value.images.length > MAX_IMAGES) throw new RequestError(400, `一次最多只能分析 ${MAX_IMAGES} 張照片。`);

  const mealNotes = Object.fromEntries(MEAL_DEFINITIONS.filter(meal => meal.id !== 'meal').map(meal => [meal.id, '']));
  if (value.mealNotes !== undefined) {
    if (!isPlainRecord(value.mealNotes)) throw new RequestError(400, 'mealNotes 必須是餐次備註物件。');
    assertOnlyKeys(value.mealNotes, Object.keys(mealNotes), 'mealNotes ');
    for (const [mealType, note] of Object.entries(value.mealNotes)) {
      if (typeof note !== 'string' || !characterCountWithin(note, MAX_NOTE_CHARACTERS)) {
        throw new RequestError(400, `${MEAL_LABELS.get(mealType)}備註最多 ${MAX_NOTE_CHARACTERS} 個字元。`);
      }
      mealNotes[mealType] = note.trim();
    }
  }

  const date = value.date === undefined ? localDateKey() : validateDateKey(value.date);
  let totalBytes = 0;
  const images = value.images.map((image, index) => {
    if (!isPlainRecord(image)) throw new RequestError(400, `第 ${index + 1} 張照片的資料格式錯誤。`);
    assertOnlyKeys(image, ['name', 'mimeType', 'dataBase64', 'note', 'mealType'], `第 ${index + 1} 張照片`);
    if (!Object.hasOwn(image, 'name') || !Object.hasOwn(image, 'mimeType') || !Object.hasOwn(image, 'dataBase64')) {
      throw new RequestError(400, `第 ${index + 1} 張照片缺少必要欄位。`);
    }

    const name = validateFilename(image.name, index);
    if (typeof image.mimeType !== 'string' || !SUPPORTED_MIME_TYPES.has(image.mimeType)) {
      throw new RequestError(400, `第 ${index + 1} 張照片格式不支援；請使用 JPEG、PNG、WebP、HEIC 或 HEIF。`);
    }
    const note = image.note === undefined ? '' : image.note;
    if (typeof note !== 'string' || !characterCountWithin(note, MAX_NOTE_CHARACTERS)) {
      throw new RequestError(400, `第 ${index + 1} 張照片的備註最多 ${MAX_NOTE_CHARACTERS} 個字元。`);
    }
    const mealType = image.mealType === undefined ? 'meal' : image.mealType;
    if (typeof mealType !== 'string' || !MEAL_LABELS.has(mealType)) {
      throw new RequestError(400, `第 ${index + 1} 張照片的餐次不支援。`);
    }
    const bytes = decodeBase64(image.dataBase64, index);
    if (!hasExpectedImageSignature(bytes, image.mimeType)) {
      throw new RequestError(400, `第 ${index + 1} 張照片的內容與格式不符，請重新選擇圖片。`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_IMAGE_BYTES) {
      throw new RequestError(413, '照片總大小超過 35 MB，請減少照片或先縮小檔案。');
    }
    return { name, mimeType: image.mimeType, note, mealType, bytes };
  });
  for (const meal of MEAL_DEFINITIONS) {
    if (images.filter(image => image.mealType === meal.id).length > MAX_IMAGES_PER_MEAL) {
      throw new RequestError(400, `${meal.label}最多只能加入 ${MAX_IMAGES_PER_MEAL} 張照片。`);
    }
  }
  if (value.mealNotes === undefined) {
    for (const mealType of Object.keys(mealNotes)) {
      mealNotes[mealType] = [...new Set(images
        .filter(image => image.mealType === mealType && image.note.trim())
        .map(image => image.note.trim()))].join('\n').slice(0, MAX_NOTE_CHARACTERS);
    }
  }
  if (!allowEmpty && images.length === 0 && !Object.values(mealNotes).some(Boolean)) {
    throw new RequestError(400, '請至少加入一張食物照片或填寫餐次備註。');
  }
  return { date, images, mealNotes, force: value.force === true, splitItems: value.splitItems !== false };
}

function historyFilePath(baseDir, date) {
  return path.join(baseDir, HISTORY_DIRECTORY, `${date}.json`);
}

async function saveHistoryRecord(baseDir, date, images, mealNotes, result, nowImpl) {
  const directory = path.join(baseDir, HISTORY_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const now = new Date(typeof nowImpl === 'function' ? nowImpl() : Date.now());
  const record = {
    version: HISTORY_RECORD_VERSION,
    date,
    savedAt: now.toISOString(),
    images: images.map(image => ({
      name: image.name,
      mimeType: image.mimeType,
      dataBase64: image.bytes.toString('base64'),
      note: image.note,
      mealType: image.mealType,
    })),
    mealNotes,
    result,
  };
  await writeFile(historyFilePath(baseDir, date), JSON.stringify(record, null, 2) + '\n', 'utf8');
}

async function deleteHistoryRecord(baseDir, date) {
  try {
    await unlink(historyFilePath(baseDir, date));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function listHistoryDates(baseDir) {
  try {
    const entries = await readdir(path.join(baseDir, HISTORY_DIRECTORY), { withFileTypes: true });
    return entries
      .filter(entry => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.json$/.test(entry.name))
      .map(entry => entry.name.slice(0, -5))
      .filter(date => {
        try { validateDateKey(date); return true; } catch { return false; }
      })
      .sort((left, right) => right.localeCompare(left));
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

async function readHistoryRecord(baseDir, date) {
  try {
    const record = JSON.parse(await readFile(historyFilePath(baseDir, date), 'utf8'));
    if (!isPlainRecord(record) || record.version !== HISTORY_RECORD_VERSION || record.date !== date
      || !Array.isArray(record.images) || !(record.result === null || isPlainRecord(record.result))) {
      throw new Error('invalid history record');
    }
    return record;
  } catch (error) {
    if (error?.code === 'ENOENT') throw new RequestError(404, '找不到這一天的歷史紀錄。');
    if (error instanceof RequestError) throw error;
    throw new Error('歷史紀錄檔案無法讀取。');
  }
}

function validateHistoryResult(value) {
  if (value === null) return null;
  if (!isPlainRecord(value) || !Array.isArray(value.photos) || !Array.isArray(value.meals)
    || !isPlainRecord(value.totals) || value.photos.length > MAX_IMAGES || value.meals.length > MEAL_DEFINITIONS.length) {
    throw new RequestError(400, 'result 必須是有效的營養分析結果或 null。');
  }
  return value;
}

function normalizeModel(value, label) {
  const model = String(value ?? '').trim().replace(/^models\//, '');
  if (!/^gemini-[a-z0-9][a-z0-9.-]*$/.test(model)) {
    throw new Error(`${label}格式錯誤。`);
  }
  return model;
}

async function loadServerConfiguration(baseDir, env) {
  let config;
  let promptText;
  try {
    [config, promptText] = await Promise.all([
      readConfig(baseDir, env),
      readFile(path.join(baseDir, 'prompt.txt'), 'utf8'),
    ]);
  } catch {
    // Parsing errors can contain fragments of .env, so keep the public/logged
    // message generic and never risk disclosing the server-side API key.
    throw new Error('無法讀取伺服器設定；請檢查 .env 與 prompt.txt。');
  }
  const prompt = promptText.replace(/^\uFEFF/, '').trim();
  if (!prompt) throw new Error('伺服器的 prompt.txt 不可為空。');
  const primaryModel = normalizeModel(config.model, 'GEMINI_MODEL ');
  const fallbackSetting = String(config.fallbackModel ?? '').trim();
  const fallbackModel = !fallbackSetting || /^(none|off)$/i.test(fallbackSetting)
    ? null
    : normalizeModel(fallbackSetting, 'GEMINI_FALLBACK_MODEL ');
  return {
    apiKey: config.apiKey === 'your_api_key_here' ? '' : config.apiKey,
    prompt,
    primaryModel,
    models: fallbackModel && fallbackModel !== primaryModel
      ? [primaryModel, fallbackModel]
      : [primaryModel],
  };
}

async function analyzeImages(images, mealNotes, splitItems, configuration, dependencies) {
  if (dependencies.signal?.aborted) throw new DOMException('營養分析已中止。', 'AbortError');
  const activeMealTypes = new Set([
    ...images.map(image => image.mealType),
    ...Object.entries(mealNotes).filter(([, note]) => note).map(([mealType]) => mealType),
  ]);
  if (activeMealTypes.size !== 1) throw new RequestError(400, '每次分析只能送出一個餐次。');
  const mealType = [...activeMealTypes][0];
  if (!MEAL_LABELS.has(mealType)) throw new RequestError(400, '餐次不支援。');
  const mealNote = mealNotes[mealType] || [...new Set(images.filter(image => image.note.trim()).map(image => image.note.trim()))].join('\n');
  const cacheKey = createAnalysisCacheKey(images, mealType, mealNote, splitItems, configuration);
  let cached = dependencies.force ? null : readAnalysisCache(dependencies.analysisCache, cacheKey);
  let reused = Boolean(cached);

  if (!cached) {
    logWith(dependencies.logger, 'log', `正在分析${MEAL_LABELS.get(mealType)}（${images.length} 張照片）…`);
    let body;
    try {
      body = buildMealRequest({ mealType, mealLabel: MEAL_LABELS.get(mealType), note: mealNote, images, splitItems }, configuration.prompt);
    } catch (error) {
      if (/大小|上限|縮小/u.test(error instanceof Error ? error.message : '')) {
        throw new RequestError(413, `${MEAL_LABELS.get(mealType)}的照片編碼後超過 Gemini 請求大小上限，請減少照片或縮小圖片。`);
      }
      throw error;
    }
    let result;
    let actualModel = configuration.primaryModel;
    for (let modelIndex = 0; modelIndex < configuration.models.length; modelIndex += 1) {
      actualModel = configuration.models[modelIndex];
      try {
        result = await callGemini({
          apiKey: configuration.apiKey,
          model: actualModel,
          body,
          fetchImpl: dependencies.fetchImpl,
          timeoutMs: dependencies.timeoutMs,
          maxAttempts: dependencies.maxAttempts,
          sleepImpl: dependencies.sleepImpl,
          randomImpl: dependencies.randomImpl,
          nowImpl: dependencies.nowImpl,
          signal: dependencies.signal,
          onRetry: retry => {
            logWith(dependencies.logger, 'warn', `${actualModel} 發生 ${retry.reason}；${(retry.delayMs / 1000).toFixed(1)} 秒後重試（第 ${retry.nextAttempt}/${retry.maxAttempts} 次）…`);
            dependencies.onRetry?.({ ...retry, model: actualModel, image: MEAL_LABELS.get(mealType) });
          },
        });
        break;
      } catch (error) {
        const hasFallback = modelIndex + 1 < configuration.models.length;
        if (!(error instanceof GeminiRequestError) || !error.allowFallback || !hasFallback) throw error;
        logWith(dependencies.logger, 'warn', `${actualModel} 暫時無法使用，改用備援模型 ${configuration.models[modelIndex + 1]}…`);
      }
    }
    cached = { analysis: result.analysis, model: actualModel };
    writeAnalysisCache(dependencies.analysisCache, cacheKey, cached);
    logWith(dependencies.logger, 'log', `${MEAL_LABELS.get(mealType)}分析完成。`);
  } else {
    logWith(dependencies.logger, 'log', `${MEAL_LABELS.get(mealType)}未變更，沿用先前分析結果。`);
  }

  const assessments = cached.analysis.photo_assessments;
  if (!Array.isArray(assessments) || assessments.length !== images.length
    || new Set(assessments.map(item => item.photo_index)).size !== images.length
    || assessments.some(item => item.photo_index < 0 || item.photo_index >= images.length)) {
    throw new Error('Gemini 回傳的照片判斷數量與本餐照片不一致。');
  }
  const orderedAssessments = [...assessments].sort((first, second) => first.photo_index - second.photo_index);
  const preferred = orderedAssessments.find(item => item.role === 'product_front')
    || orderedAssessments.find(item => item.role !== 'nutrition_label' && item.role !== 'other')
    || orderedAssessments[0];
  const sourcePhoto = preferred ? images[preferred.photo_index]?.name : '文字備註';
  const items = cached.analysis.items.map((item, itemIndex) => ({ ...item, source_photo: sourcePhoto, source_item_index: itemIndex }));
  const photos = images.map((image, index) => {
    const assessment = orderedAssessments[index];
    return {
      name: image.name,
      mealType,
      model: cached.model,
      role: assessment.role,
      subject_identity: assessment.subject_identity,
      visible_item_count: assessment.visible_item_count,
      include_in_report: assessment.include_in_report,
      analysis: {
        report_crop_box: assessment.report_crop_box,
        photo_role: assessment.role,
        subject_identity: assessment.subject_identity,
        visible_item_count: assessment.visible_item_count,
        include_in_report: assessment.include_in_report,
        items: [],
        uncertainty_notes: [],
      },
      totals: calculateTotals([]),
      reused,
    };
  });
  const totals = calculateTotals(items);
  const meal = {
    id: mealType,
    label: MEAL_LABELS.get(mealType),
    note: mealNote,
    photoCount: images.length,
    items,
    totals,
    uncertainty_notes: cached.analysis.uncertainty_notes.map(note => ({ photo: sourcePhoto, note })),
  };
  return {
    model: cached.model,
    requestedModel: configuration.primaryModel,
    photos,
    meals: [meal],
    totals,
    cache: { reused: reused ? 1 : 0, analyzed: reused ? 0 : 1 },
  };
}

async function serveStatic(response, route, head, baseDir) {
  try {
    const bytes = await readFile(path.join(baseDir, 'public', route.filename));
    sendBuffer(response, 200, route.contentType, bytes, { head, cacheControl: 'no-cache' });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      fail(response, 404, '找不到頁面。', { head });
      return;
    }
    throw error;
  }
}

function parsePathname(request) {
  try {
    return new URL(request.url ?? '/', 'http://localhost').pathname;
  } catch {
    throw new RequestError(400, '網址格式錯誤。');
  }
}

/**
 * Create the local nutrition web server without listening on a port.
 * Tests and embedding callers can inject fetch and retry timing dependencies.
 */
export function createNutritionServer({
  baseDir = ROOT,
  env = process.env,
  fetchImpl = globalThis.fetch,
  logger = console,
  timeoutMs,
  maxAttempts,
  sleepImpl,
  randomImpl,
  nowImpl,
  onRetry,
} = {}) {
  const resolvedBaseDir = path.resolve(baseDir);
  const analysisCache = new Map();
  const dependencies = {
    baseDir: resolvedBaseDir,
    analysisCache,
    fetchImpl,
    logger,
    timeoutMs,
    maxAttempts,
    sleepImpl,
    randomImpl,
    nowImpl,
    onRetry,
  };

  return createServer(async (request, response) => {
    let pathname;
    try {
      pathname = parsePathname(request);
      const head = request.method === 'HEAD';
      const mobileCorsAllowed = applyMobileCors(request, response);

      if (request.method === 'OPTIONS' && pathname.startsWith('/api/')) {
        if (!mobileCorsAllowed) {
          fail(response, 403, '不允許這個 App 來源連線。');
          return;
        }
        response.writeHead(204, { ...SECURITY_HEADERS, 'Content-Length': '0' });
        response.end();
        return;
      }

      if (pathname === '/api/health') {
        if (request.method !== 'GET' && !head) {
          methodNotAllowed(response, ['GET', 'HEAD']);
          return;
        }
        sendJson(response, 200, { status: 'ok' }, { head });
        return;
      }

      if (pathname === '/api/history') {
        if (request.method !== 'GET' && !head) {
          methodNotAllowed(response, ['GET', 'HEAD']);
          return;
        }
        sendJson(response, 200, { dates: await listHistoryDates(resolvedBaseDir) }, { head });
        return;
      }

      const historyMatch = pathname.match(/^\/api\/history\/(\d{4}-\d{2}-\d{2})$/);
      if (historyMatch) {
        const date = validateDateKey(historyMatch[1]);
        if (request.method === 'GET' || head) {
          sendJson(response, 200, await readHistoryRecord(resolvedBaseDir, date), { head });
          return;
        }
        if (request.method === 'DELETE') {
          await deleteHistoryRecord(resolvedBaseDir, date);
          sendJson(response, 200, { deleted: true, date });
          return;
        }
        if (request.method !== 'PUT') {
          methodNotAllowed(response, ['GET', 'HEAD', 'PUT', 'DELETE']);
          return;
        }
        const contentType = request.headers['content-type'] ?? '';
        if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
          throw new RequestError(400, 'Content-Type 必須是 application/json。');
        }
        if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
          throw new RequestError(400, '不支援壓縮過的請求內容。');
        }
        let payload;
        try {
          payload = JSON.parse((await readRequestBody(request)).toString('utf8'));
        } catch (error) {
          if (error instanceof RequestError) throw error;
          throw new RequestError(400, '請求內容不是有效的 JSON。');
        }
        if (!isPlainRecord(payload)) throw new RequestError(400, 'JSON 最外層必須是物件。');
        assertOnlyKeys(payload, ['date', 'images', 'mealNotes', 'result'], 'JSON ');
        if (payload.date !== date) throw new RequestError(400, '網址日期與 JSON 日期不一致。');
        const validated = validatePayload({ date: payload.date, images: payload.images, mealNotes: payload.mealNotes }, { allowEmpty: true });
        const result = validateHistoryResult(payload.result);
        if (validated.images.length === 0 && !Object.values(validated.mealNotes).some(Boolean)) {
          await deleteHistoryRecord(resolvedBaseDir, date);
          sendJson(response, 200, { deleted: true, date });
          return;
        }
        await saveHistoryRecord(resolvedBaseDir, date, validated.images, validated.mealNotes, result, nowImpl);
        sendJson(response, 200, { saved: true, date });
        return;
      }

      if (pathname === '/api/analyze') {
        if (request.method !== 'POST') {
          methodNotAllowed(response, ['POST'], head);
          return;
        }
        const contentType = request.headers['content-type'] ?? '';
        if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
          throw new RequestError(400, 'Content-Type 必須是 application/json。');
        }
        if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
          throw new RequestError(400, '不支援壓縮過的請求內容。');
        }
        const clientApiKey = readClientApiKey(request);
        const historyStorage = request.headers['x-nutrition-history'];
        if (historyStorage !== undefined && historyStorage !== 'device') {
          throw new RequestError(400, '歷史紀錄儲存方式不受支援。');
        }
        const bytes = await readRequestBody(request);
        let payload;
        try {
          payload = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw new RequestError(400, '請求內容不是有效的 JSON。');
        }
        const { date, images, mealNotes, force, splitItems } = validatePayload(payload);

        let configuration;
        try {
          configuration = await loadServerConfiguration(resolvedBaseDir, env);
        } catch (error) {
          logWith(logger, 'error', `伺服器設定錯誤：${redactedMessage(error)}`);
          fail(response, 500, redactedMessage(error));
          return;
        }
        configuration = { ...configuration, apiKey: clientApiKey || configuration.apiKey };
        if (!configuration.apiKey) {
          throw new RequestError(400, '請先在右上角設定中填入自己的 Google AI Studio API key。');
        }

        const analysisController = new AbortController();
        const abortAnalysis = () => {
          if (!response.writableEnded) analysisController.abort('client-disconnected');
        };
        request.once('aborted', abortAnalysis);
        response.once('close', abortAnalysis);
        try {
          const result = await analyzeImages(images, mealNotes, splitItems, configuration, { ...dependencies, signal: analysisController.signal, force });
          result.date = date;
          if (historyStorage !== 'device') {
            try {
              await saveHistoryRecord(resolvedBaseDir, date, images, mealNotes, result, nowImpl);
            } catch (error) {
              logWith(logger, 'error', `歷史紀錄儲存失敗：${redactedMessage(error)}`);
              throw new RequestError(500, '分析已完成，但歷史紀錄無法儲存；請檢查專案資料夾的寫入權限後重試。');
            }
          }
          sendJson(response, 200, result);
        } catch (error) {
          if (analysisController.signal.aborted || response.destroyed) {
            logWith(logger, 'log', '用戶端已中止營養分析。');
            return;
          }
          if (error instanceof RequestError) throw error;
          const publicMessage = redactedMessage(error, configuration.apiKey);
          const status = error instanceof GeminiRequestError && (error.status === 429 || error.status === 503)
            ? error.status
            : 502;
          logWith(logger, 'error', `營養分析失敗：${publicMessage}`);
          fail(response, status, publicMessage || 'Gemini 暫時無法完成營養分析，請稍後再試。');
        } finally {
          request.removeListener('aborted', abortAnalysis);
          response.removeListener('close', abortAnalysis);
        }
        return;
      }

      const staticRoute = STATIC_FILES.get(pathname);
      if (staticRoute) {
        if (request.method !== 'GET' && !head) {
          methodNotAllowed(response, ['GET', 'HEAD']);
          return;
        }
        await serveStatic(response, staticRoute, head, resolvedBaseDir);
        return;
      }

      fail(response, 404, '找不到頁面。', { head });
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof RequestError) {
        fail(response, error.status, error.message, { head: request.method === 'HEAD' });
        return;
      }
      logWith(logger, 'error', `伺服器錯誤：${redactedMessage(error)}`);
      fail(response, 500, '伺服器發生未預期的錯誤。', { head: request.method === 'HEAD' });
    }
  });
}

function readPort(value) {
  if (value === undefined || value === '') return DEFAULT_PORT;
  if (!/^\d+$/.test(value)) throw new Error('PORT 必須是 1 到 65535 的整數。');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT 必須是 1 到 65535 的整數。');
  }
  return port;
}

function readHost(value) {
  if (value === undefined || value === '') return DEFAULT_HOST;
  if (value === '127.0.0.1' || value === '0.0.0.0') return value;
  throw new Error('HOST 只接受 127.0.0.1 或 0.0.0.0。');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let port;
  let host;
  try {
    port = readPort(process.env.PORT);
    host = readHost(process.env.HOST);
  } catch (error) {
    console.error(`啟動失敗：${error.message}`);
    process.exitCode = 1;
  }

  if (port !== undefined) {
    const server = createNutritionServer();
    server.on('error', error => {
      console.error(`伺服器錯誤：${redactedMessage(error)}`);
      process.exitCode = 1;
    });
    server.listen(port, host, () => {
      console.log(`營養分析介面已啟動：http://${host}:${port}`);
      if (host === '0.0.0.0') console.log('請在手機開啟：http://<這台電腦的區域網路 IP>:' + port);
    });

    let closing = false;
    const close = signal => {
      if (closing) return;
      closing = true;
      console.log(`收到 ${signal}，正在關閉伺服器…`);
      server.close(error => {
        if (error) {
          console.error(`關閉失敗：${redactedMessage(error)}`);
          process.exitCode = 1;
        }
      });
    };
    process.once('SIGINT', () => close('SIGINT'));
    process.once('SIGTERM', () => close('SIGTERM'));
  }
}
