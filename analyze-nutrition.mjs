import { readFile, readdir, stat, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, parseEnv } from 'node:util';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MODEL = 'gemini-3.1-flash-lite';
const DEFAULT_FALLBACK_MODEL = 'gemini-3.8-flash';
const DEFAULT_MAX_ATTEMPTS = 6;
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MIME_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.heic': 'image/heic', '.heif': 'image/heif',
};
const MAX_IMAGE_BYTES = 14_000_000;
const MAX_REQUEST_BYTES = 19_000_000; // Leave room below Google's 20 MB inline limit.
export const NUTRIENTS = {
  calories_kcal: '熱量 (kcal)', protein_g: '蛋白質 (g)', fat_g: '脂肪 (g)',
  carbs_g: '碳水化合物 (g)', fiber_g: '膳食纖維 (g)', sugar_g: '糖 (g)', sodium_mg: '鈉 (mg)',
};
const nonnegativeNumber = { type: 'number', minimum: 0 };
const stringList = { type: 'array', items: { type: 'string' } };
const normalizedCoordinate = { type: 'number', minimum: 0, maximum: 1000 };
const reportCropBox = {
  type: 'object',
  properties: {
    top: normalizedCoordinate,
    left: normalizedCoordinate,
    bottom: normalizedCoordinate,
    right: normalizedCoordinate,
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['top', 'left', 'bottom', 'right', 'confidence'],
};
const photoAssessment = {
  type: 'object',
  properties: {
    photo_index: { type: 'integer', minimum: 0 },
    role: { type: 'string', enum: ['food', 'product_front', 'nutrition_label', 'mixed', 'other'] },
    subject_identity: { type: 'string' },
    visible_item_count: { type: 'integer', minimum: 0 },
    include_in_report: { type: 'boolean' },
    report_crop_box: reportCropBox,
  },
  required: ['photo_index', 'role', 'subject_identity', 'visible_item_count', 'include_in_report', 'report_crop_box'],
};
const itemProperties = {
  name: { type: 'string' },
  estimated_weight_g: nonnegativeNumber,
  ...Object.fromEntries(Object.keys(NUTRIENTS).map(key => [key, nonnegativeNumber])),
  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  assumptions: stringList,
};
export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    is_food: { type: 'boolean' },
    meal_name: { type: 'string' },
    items: {
      type: 'array',
      items: { type: 'object', properties: itemProperties, required: Object.keys(itemProperties) },
    },
    uncertainty_notes: stringList,
    report_crop_box: reportCropBox,
    photo_assessments: { type: 'array', items: photoAssessment },
  },
  required: ['is_food', 'meal_name', 'items', 'uncertainty_notes', 'report_crop_box', 'photo_assessments'],
};

const SYSTEM_INSTRUCTION = '你是餐點營養估算助手。依同一餐的所有照片與共用文字說明分析，以繁體中文填寫指定 JSON。數字均為該餐實際吃下份量的總營養量。同一個包裝食品的正面、營養成分標示或不同角度只代表一個品項，必須合併資訊且只能計算一次；營養成分標示優先作為數值依據，一般商品照用來辨識品名與包裝。實物食物缺少精確資料時，必須依畫面份量與常見食材做合理估算，並在 assumptions 或 uncertainty_notes 說明不確定性。若包裝營養標示沒有列出或無法讀到膳食纖維、糖或其他必填營養項目，必須依產品類型、配料、份量與常見同類食品合理估算，並在 assumptions 說明；不得僅因標示缺項就填 0。只有標示明確寫為 0，或依食品性質可合理判定幾乎不含該成分時才填 0。所有 estimated_weight_g 與營養欄位都必須是非負數字，不得輸出 null 或留白。沒有照片時必須依共用文字說明合理估算。不要捏造資料來源。若照片與文字都無法辨識餐點，is_food 設為 false、items 為空陣列並在 uncertainty_notes 說明。photo_assessments 必須依輸入照片順序逐張回傳且 photo_index 從 0 開始；visible_item_count 是該張照片中可辨識的不同食物或飲料品項數，一盤同時有飯、魚排、蛋與配菜就依實際品項計數，單一零食或飲料填 1，純營養標示若只對應一個商品也填 1，不可使用整餐照片總數代替。role 判斷為 food、product_front、nutrition_label、mixed 或 other，其中只要畫面主體是營養成分標示就使用 nutrition_label，不以照片是否為包裝背面判斷；同一包裝品的商品照與營養標示照必須使用完全相同且具體的 subject_identity，不確定時使用「無法確認」。include_in_report 用來決定報告是否顯示該照片：同一品項同時有一般商品照與營養成分標示照時，一般商品照設為 true、營養標示照設為 false；若該品項只有營養標示照而沒有一般商品照，營養標示照必須設為 true；不同品項不得互相排除。一般食物照片設為 true。每張照片的 report_crop_box 是供報告排版使用的建議裁切框，座標以原圖左上角為原點並正規化為 0 到 1000；裁切框必須涵蓋所有食物、飲料、份量參照，以及包裝正面或重要標示，只移除明顯無關背景。若無法安全裁切，回傳完整範圍並將 confidence 設為 low。最外層 report_crop_box 在有照片時使用第 0 張照片的裁切框，沒有照片時使用完整範圍且 confidence 設為 low。';

function splitItemsInstruction(splitItems) {
  return splitItems
    ? '細項拆分已開啟：必須將畫面中可辨識且可分開估算的食物各自列為一個 item。不可只用組合餐名稱概括整盤；例如魚排咖哩應拆成炸魚排、咖哩醬、白飯、玉米筍、荷包蛋等實際可見細項。烹調油可併入所屬食物，避免同一成分重複計算。'
    : '細項拆分已關閉：可以把屬於同一道料理且通常一起食用的內容合併為一個 item，但仍不可重複計算。';
}

const HELP = `用法：node analyze-nutrition.mjs [選項]

  --data-dir PATH     圖片與同名 .annotation.txt / .txt 的資料夾（預設 data）
  --prompt-file PATH  共用文字 prompt（預設 prompt.txt）
  --output-dir PATH   報告根目錄（預設 results）
  --model ID          Gemini 模型；優先於 GEMINI_MODEL
  --fallback-model ID 主模型暫時失敗時使用的模型；填 none 可停用
  --dry-run           檢查檔案與配對；不需 API key、不呼叫 API
  --help              顯示說明

預設路徑以腳本所在目錄為準；自訂相對路徑以目前工作目錄為準。
將 .env.example 複製為 .env，再設定 GEMINI_API_KEY。暫時性錯誤會自動有限次重試。
`;

async function readOptional(filename) {
  try { return await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function readConfig(baseDir = ROOT, env = process.env) {
  const content = await readOptional(path.join(baseDir, '.env'));
  const local = content === null ? {} : parseEnv(content.replace(/^\uFEFF/, ''));
  return {
    apiKey: (env.GEMINI_API_KEY ?? local.GEMINI_API_KEY ?? '').trim(),
    model: (env.GEMINI_MODEL ?? local.GEMINI_MODEL ?? DEFAULT_MODEL).trim(),
    fallbackModel: (env.GEMINI_FALLBACK_MODEL ?? local.GEMINI_FALLBACK_MODEL ?? DEFAULT_FALLBACK_MODEL).trim(),
  };
}

export async function discoverMeals(dataDir) {
  const entries = await readdir(dataDir, { withFileTypes: true });
  const images = entries.filter(entry => entry.isFile() && MIME_TYPES[path.extname(entry.name).toLowerCase()])
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!images.length) throw new Error(`找不到支援的圖片：${dataDir}（支援 JPG、PNG、WebP、HEIC、HEIF）`);
  const meals = [];
  for (const image of images) {
    const imagePath = path.join(dataDir, image.name);
    const stem = path.parse(image.name).name;
    let annotation = '';
    let annotationPath = null;
    for (const suffix of ['.annotation.txt', '.txt']) {
      const candidate = path.join(dataDir, stem + suffix);
      const text = await readOptional(candidate);
      if (text !== null) {
        annotation = text.replace(/^\uFEFF/, '').trim();
        annotationPath = candidate;
        break;
      }
    }
    const { size } = await stat(imagePath);
    if (!size || size > MAX_IMAGE_BYTES) {
      throw new Error(`${image.name} 為空檔或超過 14 MB；請先縮小圖片後再執行。`);
    }
    meals.push({ imagePath, annotationPath, annotation, size, mimeType: MIME_TYPES[path.extname(image.name).toLowerCase()] });
  }
  return meals;
}

export function buildRequest(meal, imageBytes, prompt) {
  const text = `${prompt}\n\n這是照片 0（檔名：${path.basename(meal.imagePath)}）。\n\n以下是這張圖片的使用者餐點說明：\n${meal.annotation || '（沒有文字說明；請依照片估算並標示不確定性。）'}`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: meal.mimeType, data: imageBytes.toString('base64') } },
      { text },
    ] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 16384,
    },
  });
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    throw new Error('圖片與文字編碼後超過請求大小上限，請縮小圖片或減少文字。');
  }
  return body;
}

export function buildMealRequest({ mealType, mealLabel, note, images, splitItems = true }, prompt) {
  const photoParts = images.flatMap((image, index) => [
    { text: `照片 ${index}（檔名：${image.name}）` },
    { inlineData: { mimeType: image.mimeType, data: image.bytes.toString('base64') } },
  ]);
  const text = `${prompt}\n\n用餐時段：${mealLabel || mealType}\n共用餐次備註：\n${note || '（沒有文字說明，請依照片估算。）'}\n\n${splitItemsInstruction(splitItems)}\n\n請整合同一餐的全部照片；一般商品照與營養成分標示照若屬同一品項，只計算一次，並依 include_in_report 規則決定報告選圖。`;
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: 'user', parts: [...photoParts, { text }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 16384,
    },
  });
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    throw new Error('同一餐的照片與文字編碼後超過請求大小上限，請減少照片或縮小圖片。');
  }
  return body;
}

export function validateAnalysis(value) {
  const isText = text => typeof text === 'string' && text.trim().length > 0;
  const isTextList = list => Array.isArray(list) && list.every(isText);
  if (!value || typeof value.is_food !== 'boolean' || !isText(value.meal_name)
    || !Array.isArray(value.items) || !isTextList(value.uncertainty_notes)) {
    throw new Error('Gemini 回傳的 JSON 結構不完整，未產生營養報告。');
  }
  if (!value.is_food || value.items.length === 0) {
    throw new Error(`Gemini 無法辨識可分析的餐點：${value.uncertainty_notes.join('；') || '請提供清晰照片與份量說明。'}`);
  }
  if (value.report_crop_box !== undefined) {
    const crop = value.report_crop_box;
    const coordinateKeys = ['top', 'left', 'bottom', 'right'];
    if (!crop || !['high', 'medium', 'low'].includes(crop.confidence)
      || coordinateKeys.some(key => typeof crop[key] !== 'number' || !Number.isFinite(crop[key])
        || crop[key] < 0 || crop[key] > 1000)
      || crop.bottom <= crop.top || crop.right <= crop.left) {
      throw new Error('Gemini 回傳的報告裁切框格式錯誤。');
    }
  }
  if (value.photo_assessments !== undefined) {
    if (!Array.isArray(value.photo_assessments)) throw new Error('Gemini 回傳的照片判斷格式錯誤。');
    for (const assessment of value.photo_assessments) {
      const crop = assessment?.report_crop_box;
      const coordinateKeys = ['top', 'left', 'bottom', 'right'];
      if (!assessment || !Number.isInteger(assessment.photo_index) || assessment.photo_index < 0
        || !['food', 'product_front', 'nutrition_label', 'mixed', 'other'].includes(assessment.role)
        || !isText(assessment.subject_identity)
        || !Number.isInteger(assessment.visible_item_count) || assessment.visible_item_count < 0
        || typeof assessment.include_in_report !== 'boolean'
        || !crop || !['high', 'medium', 'low'].includes(crop.confidence)
        || coordinateKeys.some(key => typeof crop[key] !== 'number' || !Number.isFinite(crop[key]) || crop[key] < 0 || crop[key] > 1000)
        || crop.bottom <= crop.top || crop.right <= crop.left) {
        throw new Error('Gemini 回傳的照片判斷或裁切框格式錯誤。');
      }
    }
  }
  for (const item of value.items) {
    if (!item || !isText(item.name) || !['high', 'medium', 'low'].includes(item.confidence)
      || !isTextList(item.assumptions)) {
      throw new Error('Gemini 回傳的食物名稱、信心程度或假設格式錯誤。');
    }
    for (const key of ['estimated_weight_g', ...Object.keys(NUTRIENTS)]) {
      if (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0) {
        throw new Error(`Gemini 回傳 ${item.name} 的 ${key} 不是有效的非負數字。`);
      }
    }
  }
  return value;
}

export function calculateTotals(items) {
  return Object.fromEntries(Object.keys(NUTRIENTS).map(key => [key,
    Math.round(items.reduce((sum, item) => sum + item[key], 0) * 10) / 10,
  ]));
}

export function parseGeminiResponse(payload) {
  if (payload.promptFeedback?.blockReason) throw new Error('Gemini 封鎖了此請求，請檢查照片及 prompt。');
  const candidate = payload.candidates?.[0];
  if (!candidate || candidate.finishReason !== 'STOP') {
    throw new Error(`Gemini 未完整回覆（${candidate?.finishReason || '沒有候選回覆'}），未產生營養報告。`);
  }
  const text = (candidate.content?.parts ?? []).filter(part => !part.thought && typeof part.text === 'string')
    .map(part => part.text).join('');
  let analysis;
  try { analysis = JSON.parse(text); }
  catch { throw new Error('Gemini 未回傳有效 JSON，請重新執行。'); }
  return validateAnalysis(analysis);
}

export class GeminiRequestError extends Error {
  constructor(message, { retryable = false, allowFallback = false, status = null } = {}) {
    super(message);
    this.name = 'GeminiRequestError';
    this.retryable = retryable;
    this.allowFallback = allowFallback;
    this.status = status;
  }
}

function retryAfterMilliseconds(response, nowImpl) {
  const value = response.headers?.get?.('retry-after')?.trim();
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowImpl()) : 0;
}

function retryDelayMilliseconds(attempt, response, randomImpl, nowImpl) {
  const exponentialMaximum = Math.min(60_000, 1000 * (2 ** (attempt - 1)));
  const jittered = exponentialMaximum * (0.5 + 0.5 * randomImpl());
  return Math.round(Math.min(60_000, Math.max(jittered, retryAfterMilliseconds(response, nowImpl))));
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function abortError() {
  return new DOMException('營養分析已中止。', 'AbortError');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function waitForAbortable(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', onAbort); resolve(value); },
      error => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

function httpError(status, attempts) {
  const hints = {
    400: '請確認 API key、模型名稱及圖片格式。',
    401: 'API key 無效，請重新建立或複製。',
    403: '請確認 API key 的專案權限、地區與金鑰限制；舊 key 可改用 AI Studio 新建立的 key。',
    404: '找不到模型，請以 --model 指定專案可用的模型 ID。',
    408: '服務未在期限內完成請求。',
    429: '已達速率或額度限制，請到 AI Studio 檢查配額，稍後再試。',
    500: 'Gemini 服務發生暫時性內部錯誤。',
    502: 'Gemini 上游服務暫時無法回應。',
    503: 'Gemini 模型目前過載或服務暫時無法使用。',
    504: 'Gemini 服務回應逾時。',
  };
  const retryable = RETRYABLE_HTTP_STATUS.has(status);
  const suffix = retryable && attempts > 1 ? `（共嘗試 ${attempts} 次）` : '';
  return new GeminiRequestError(
    `Gemini API HTTP ${status}：${hints[status] || '服務無法完成請求，請稍後再試。'}${suffix}`,
    { retryable, allowFallback: retryable && status !== 429, status },
  );
}

export async function callGemini({
  apiKey, model, body, fetchImpl = fetch, timeoutMs = 60_000,
  maxAttempts = DEFAULT_MAX_ATTEMPTS, sleepImpl = sleep,
  randomImpl = Math.random, nowImpl = Date.now, onRetry = () => {}, signal,
}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('maxAttempts 必須是大於零的整數。');
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    let response;
    try {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw abortError();
      const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
      const network = error instanceof TypeError;
      if (!timeout && !network) throw error;
      if (attempt < maxAttempts) {
        const delayMs = retryDelayMilliseconds(attempt, {}, randomImpl, nowImpl);
        onRetry({ attempt, nextAttempt: attempt + 1, maxAttempts, delayMs, reason: timeout ? '請求逾時' : '網路連線失敗' });
        await waitForAbortable(sleepImpl(delayMs), signal);
        continue;
      }
      const reason = timeout ? 'Gemini 請求逾時' : '無法連線至 Gemini';
      throw new GeminiRequestError(`${reason}（共嘗試 ${attempt} 次）`, { retryable: true, allowFallback: true });
    }

    if (!response.ok) {
      const retryable = RETRYABLE_HTTP_STATUS.has(response.status);
      if (retryable && attempt < maxAttempts) {
        const delayMs = retryDelayMilliseconds(attempt, response, randomImpl, nowImpl);
        onRetry({ attempt, nextAttempt: attempt + 1, maxAttempts, delayMs, reason: `HTTP ${response.status}` });
        await waitForAbortable(sleepImpl(delayMs), signal);
        continue;
      }
      // Do not echo server error bodies: these may contain request details.
      throw httpError(response.status, attempt);
    }

    let payload;
    throwIfAborted(signal);
    try { payload = await response.json(); }
    catch (error) {
      if (error instanceof TypeError && attempt < maxAttempts) {
        const delayMs = retryDelayMilliseconds(attempt, response, randomImpl, nowImpl);
        onRetry({ attempt, nextAttempt: attempt + 1, maxAttempts, delayMs, reason: '回應傳輸中斷' });
        await sleepImpl(delayMs);
        continue;
      }
      if (error instanceof TypeError) {
        throw new GeminiRequestError(`Gemini 回應傳輸中斷（共嘗試 ${attempt} 次）`, { retryable: true, allowFallback: true });
      }
      throw new Error('Gemini API 回傳了無法解析的 JSON。');
    }
    return { analysis: parseGeminiResponse(payload), usage: payload.usageMetadata ?? null };
  }
  throw new Error('Gemini 重試流程異常結束。');
}

function cell(value) {
  return String(value ?? 0).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
}

export function renderMarkdown(report) {
  const { analysis, totals } = report;
  const confidence = { high: '高', medium: '中', low: '低' };
  const lines = [
    `# ${cell(analysis.meal_name)}`, '',
    `圖片：${cell(report.image)}  `, `模型：${cell(report.model)}  `, `時間：${cell(report.created_at)}`, '',
    '以下為照片與文字的估算；份量與烹調油會影響結果。實物照片缺少精確資料時採合理估算，包裝標示未列出的營養項目以 0 呈現。', '',
    `| 食物 | 估計熟重 (g) | ${Object.values(NUTRIENTS).join(' | ')} | 信心 |`,
    `| ${Array(Object.keys(NUTRIENTS).length + 3).fill('---').join(' | ')} |`,
  ];
  for (const item of analysis.items) {
    lines.push(`| ${[item.name, item.estimated_weight_g, ...Object.keys(NUTRIENTS).map(key => item[key]), confidence[item.confidence]].map(cell).join(' | ')} |`);
  }
  lines.push(`| **合計** | — | ${Object.keys(NUTRIENTS).map(key => cell(totals[key])).join(' | ')} | — |`, '',
    '合計由腳本加總各項數值。', '', '## 估算假設', '');
  for (const item of analysis.items) lines.push(`- **${cell(item.name)}**：${cell(item.assumptions.join('；') || '未提供額外假設')}`);
  lines.push('', '## 不確定性與可補充資料', '');
  for (const note of analysis.uncertainty_notes) lines.push(`- ${cell(note)}`);
  return lines.join('\n') + '\n';
}

export async function main(argv = process.argv.slice(2), {
  baseDir = ROOT, env = process.env, fetchImpl = fetch, log = console.log, errorLog = console.error,
  maxAttempts = DEFAULT_MAX_ATTEMPTS, sleepImpl = sleep, randomImpl = Math.random, nowImpl = Date.now,
} = {}) {
  const { values } = parseArgs({ args: argv, options: {
    'data-dir': { type: 'string' }, 'output-dir': { type: 'string' },
    'prompt-file': { type: 'string' }, model: { type: 'string' }, 'fallback-model': { type: 'string' },
    'dry-run': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  } });
  if (values.help) { log(HELP); return 0; }
  const config = await readConfig(baseDir, env);
  const model = (values.model ?? config.model).replace(/^models\//, '');
  if (!/^gemini-[a-z0-9][a-z0-9.-]*$/.test(model)) throw new Error('模型 ID 格式錯誤，請使用例如 gemini-3.1-flash-lite。');
  const fallbackSetting = String(values['fallback-model'] ?? config.fallbackModel).trim();
  const fallbackModel = /^(none|off)$/i.test(fallbackSetting) ? null : fallbackSetting.replace(/^models\//, '');
  if (fallbackModel && !/^gemini-[a-z0-9][a-z0-9.-]*$/.test(fallbackModel)) {
    throw new Error('備援模型 ID 格式錯誤，請使用例如 gemini-3.8-flash，或填 none 停用。');
  }
  const models = fallbackModel && fallbackModel !== model ? [model, fallbackModel] : [model];
  const dataDir = path.resolve(values['data-dir'] ?? path.join(baseDir, 'data'));
  const promptPath = path.resolve(values['prompt-file'] ?? path.join(baseDir, 'prompt.txt'));
  const outputRoot = path.resolve(values['output-dir'] ?? path.join(baseDir, 'results'));
  const prompt = (await readFile(promptPath, 'utf8')).replace(/^\uFEFF/, '').trim();
  if (!prompt) throw new Error('prompt 檔案不可為空。');
  const meals = await discoverMeals(dataDir);
  log(`模型：${model}${models.length > 1 ? `；備援：${models[1]}` : '；未啟用備援'}；共 ${meals.length} 張圖片。`);
  for (const meal of meals) {
    log(`  ${path.basename(meal.imagePath)} + ${meal.annotationPath ? path.basename(meal.annotationPath) : '（無文字說明）'}`);
  }
  if (values['dry-run']) {
    for (const meal of meals) {
      buildRequest(meal, await readFile(meal.imagePath), prompt);
      log(`\n${path.basename(meal.imagePath)} 的說明：${meal.annotation || '（無）'}`);
    }
    log(`\n共用 prompt：${promptPath}\n${prompt}\n\n檢查完成；未呼叫 API，也未建立報告。`);
    return 0;
  }
  if (!config.apiKey || config.apiKey === 'your_api_key_here') {
    throw new Error('尚未設定 GEMINI_API_KEY。請將 .env.example 複製為 .env，貼入你的 AI Studio API key 後再執行。');
  }
  let runDir;
  let failed = 0;
  for (const meal of meals) {
    try {
      log(`\n正在分析 ${path.basename(meal.imagePath)}…`);
      const body = buildRequest(meal, await readFile(meal.imagePath), prompt);
      let result;
      let usedModel = model;
      for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
        usedModel = models[modelIndex];
        try {
          result = await callGemini({
            apiKey: config.apiKey, model: usedModel, body, fetchImpl,
            maxAttempts, sleepImpl, randomImpl, nowImpl,
            onRetry: ({ nextAttempt, maxAttempts: attempts, delayMs, reason }) => {
              log(`${usedModel} 發生 ${reason}；${(delayMs / 1000).toFixed(1)} 秒後重試（第 ${nextAttempt}/${attempts} 次）…`);
            },
          });
          break;
        } catch (error) {
          const hasFallback = modelIndex + 1 < models.length;
          if (!error.allowFallback || !hasFallback) throw error;
          log(`${usedModel} 多次嘗試仍暫時無法使用，改用備援模型 ${models[modelIndex + 1]}…`);
        }
      }
      const report = {
        created_at: new Date().toISOString(), model: usedModel, requested_model: model,
        image: path.basename(meal.imagePath),
        annotation_file: meal.annotationPath ? path.basename(meal.annotationPath) : null,
        annotation: meal.annotation, prompt,
        analysis: result.analysis, totals: calculateTotals(result.analysis.items), usage: result.usage,
      };
      if (!runDir) {
        await mkdir(outputRoot, { recursive: true });
        runDir = await mkdtemp(path.join(outputRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-`));
      }
      const filename = path.join(runDir, path.basename(meal.imagePath) + '.nutrition');
      await writeFile(filename + '.json', JSON.stringify(report, null, 2) + '\n', 'utf8');
      await writeFile(filename + '.md', renderMarkdown(report), 'utf8');
      log(`熱量估算：${report.totals.calories_kcal ?? 0} kcal；蛋白質：${report.totals.protein_g ?? 0} g`);
      log(`報告：${filename}.md`);
    } catch (error) {
      failed += 1;
      errorLog(`${path.basename(meal.imagePath)} 分析失敗：${String(error.message).replaceAll(config.apiKey, '[REDACTED]')}`);
    }
  }
  log(`\n完成：${meals.length - failed} 張成功，${failed} 張失敗。${runDir ? `\n輸出目錄：${runDir}` : ''}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`錯誤：${error.message}`);
    process.exitCode = 1;
  });
}
