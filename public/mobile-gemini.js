import { CapacitorHttp } from "@capacitor/core";

const PRIMARY_MODEL = "gemini-3.1-flash-lite";
const FALLBACK_MODEL = "gemini-3.8-flash";
const DEFAULT_MAX_ATTEMPTS = 6;
const MAX_REQUEST_BYTES = 19_000_000;
const MAX_IMAGES_PER_MEAL = 10;
const MAX_CACHE_ENTRIES = 100;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MEALS = [
  { id: "breakfast", label: "早餐" },
  { id: "lunch", label: "午餐" },
  { id: "afternoon_tea", label: "下午茶" },
  { id: "dinner", label: "晚餐" },
  { id: "late_night", label: "宵夜" },
];
const MEAL_LABELS = new Map(MEALS.map(meal => [meal.id, meal.label]));
const NUTRIENT_KEYS = ["calories_kcal", "protein_g", "fat_g", "carbs_g", "fiber_g", "sugar_g", "sodium_mg"];
const nonnegativeNumber = { type: "number", minimum: 0 };
const stringList = { type: "array", items: { type: "string" } };
const normalizedCoordinate = { type: "number", minimum: 0, maximum: 1000 };
const reportCropBox = {
  type: "object",
  properties: {
    top: normalizedCoordinate,
    left: normalizedCoordinate,
    bottom: normalizedCoordinate,
    right: normalizedCoordinate,
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["top", "left", "bottom", "right", "confidence"],
};
const photoAssessment = {
  type: "object",
  properties: {
    photo_index: { type: "integer", minimum: 0 },
    role: { type: "string", enum: ["food", "product_front", "nutrition_label", "mixed", "other"] },
    subject_identity: { type: "string" },
    visible_item_count: { type: "integer", minimum: 0 },
    include_in_report: { type: "boolean" },
    report_crop_box: reportCropBox,
  },
  required: ["photo_index", "role", "subject_identity", "visible_item_count", "include_in_report", "report_crop_box"],
};
const itemProperties = {
  name: { type: "string" },
  estimated_weight_g: nonnegativeNumber,
  ...Object.fromEntries(NUTRIENT_KEYS.map(key => [key, nonnegativeNumber])),
  confidence: { type: "string", enum: ["high", "medium", "low"] },
  assumptions: stringList,
};

export const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    is_food: { type: "boolean" },
    meal_name: { type: "string" },
    items: {
      type: "array",
      items: { type: "object", properties: itemProperties, required: Object.keys(itemProperties) },
    },
    uncertainty_notes: stringList,
    report_crop_box: reportCropBox,
    photo_assessments: { type: "array", items: photoAssessment },
  },
  required: ["is_food", "meal_name", "items", "uncertainty_notes", "report_crop_box", "photo_assessments"],
};

const SYSTEM_INSTRUCTION = "你是餐點營養估算助手。依同一餐的所有照片與共用文字說明分析，以繁體中文填寫指定 JSON。數字均為該餐實際吃下份量的總營養量。同一個包裝食品的正面、營養成分標示或不同角度只代表一個品項，必須合併資訊且只能計算一次；營養成分標示優先作為數值依據，一般商品照用來辨識品名與包裝。實物食物缺少精確資料時，必須依畫面份量與常見食材做合理估算，並在 assumptions 或 uncertainty_notes 說明不確定性。若包裝營養標示沒有列出或無法讀到膳食纖維、糖或其他必填營養項目，必須依產品類型、配料、份量與常見同類食品合理估算，並在 assumptions 說明；不得僅因標示缺項就填 0。只有標示明確寫為 0，或依食品性質可合理判定幾乎不含該成分時才填 0。所有 estimated_weight_g 與營養欄位都必須是非負數字，不得輸出 null 或留白。沒有照片時必須依共用文字說明合理估算。不要捏造資料來源。若照片與文字都無法辨識餐點，is_food 設為 false、items 為空陣列並在 uncertainty_notes 說明。photo_assessments 必須依輸入照片順序逐張回傳且 photo_index 從 0 開始；visible_item_count 是該張照片中可辨識的不同食物或飲料品項數，一盤同時有飯、魚排、蛋與配菜就依實際品項計數，單一零食或飲料填 1，純營養標示若只對應一個商品也填 1，不可使用整餐照片總數代替。role 判斷為 food、product_front、nutrition_label、mixed 或 other，其中只要畫面主體是營養成分標示就使用 nutrition_label，不以照片是否為包裝背面判斷；同一包裝品的商品照與營養標示照必須使用完全相同且具體的 subject_identity，不確定時使用「無法確認」。include_in_report 用來決定報告是否顯示該照片：同一品項同時有一般商品照與營養成分標示照時，一般商品照設為 true、營養標示照設為 false；若該品項只有營養標示照而沒有一般商品照，營養標示照必須設為 true；不同品項不得互相排除。一般食物照片設為 true。每張照片的 report_crop_box 是供報告排版使用的建議裁切框，座標以原圖左上角為原點並正規化為 0 到 1000；裁切框必須涵蓋所有食物、飲料、份量參照，以及包裝正面或重要標示，只移除明顯無關背景。若無法安全裁切，回傳完整範圍並將 confidence 設為 low。最外層 report_crop_box 在有照片時使用第 0 張照片的裁切框，沒有照片時使用完整範圍且 confidence 設為 low。";
const memoryCache = new Map();
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function abortError() {
  return new DOMException("營養分析已中止。", "AbortError");
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function waitForAbortable(promise, signal) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export class GeminiMobileError extends Error {
  constructor(message, { retryable = false, allowFallback = false, status = null } = {}) {
    super(message);
    this.name = "GeminiMobileError";
    this.retryable = retryable;
    this.allowFallback = allowFallback;
    this.status = status;
  }
}

export function calculateTotals(items) {
  return Object.fromEntries(NUTRIENT_KEYS.map(key => [key,
    Math.round(items.reduce((sum, item) => sum + item[key], 0) * 10) / 10,
  ]));
}

export function validateAnalysis(value) {
  const isText = text => typeof text === "string" && text.trim().length > 0;
  const isTextList = list => Array.isArray(list) && list.every(isText);
  if (!value || typeof value.is_food !== "boolean" || !isText(value.meal_name)
    || !Array.isArray(value.items) || !isTextList(value.uncertainty_notes)) {
    throw new Error("Gemini 回傳的 JSON 結構不完整，未產生營養報告。");
  }
  if (!value.is_food || value.items.length === 0) {
    throw new Error(`Gemini 無法辨識可分析的餐點：${value.uncertainty_notes.join("；") || "請提供清晰照片與份量說明。"}`);
  }
  if (value.report_crop_box !== undefined) {
    const crop = value.report_crop_box;
    const coordinateKeys = ["top", "left", "bottom", "right"];
    if (!crop || !["high", "medium", "low"].includes(crop.confidence)
      || coordinateKeys.some(key => typeof crop[key] !== "number" || !Number.isFinite(crop[key])
        || crop[key] < 0 || crop[key] > 1000)
      || crop.bottom <= crop.top || crop.right <= crop.left) {
      throw new Error("Gemini 回傳的報告裁切框格式錯誤。");
    }
  }
  if (value.photo_assessments !== undefined) {
    if (!Array.isArray(value.photo_assessments)) throw new Error("Gemini 回傳的照片判斷格式錯誤。");
    for (const assessment of value.photo_assessments) {
      if (!assessment || !Number.isInteger(assessment.photo_index) || assessment.photo_index < 0
        || !["food", "product_front", "nutrition_label", "mixed", "other"].includes(assessment.role)
        || typeof assessment.subject_identity !== "string"
        || !Number.isInteger(assessment.visible_item_count) || assessment.visible_item_count < 0
        || typeof assessment.include_in_report !== "boolean") {
        throw new Error("Gemini 回傳的照片角色或品項識別格式錯誤。");
      }
      const crop = assessment.report_crop_box;
      const coordinateKeys = ["top", "left", "bottom", "right"];
      if (!crop || !["high", "medium", "low"].includes(crop.confidence)
        || coordinateKeys.some(key => typeof crop[key] !== "number" || !Number.isFinite(crop[key])
          || crop[key] < 0 || crop[key] > 1000)
        || crop.bottom <= crop.top || crop.right <= crop.left) {
        throw new Error("Gemini 回傳的照片裁切框格式錯誤。");
      }
    }
  }
  for (const item of value.items) {
    if (!item || !isText(item.name) || !["high", "medium", "low"].includes(item.confidence)
      || !isTextList(item.assumptions)) {
      throw new Error("Gemini 回傳的食物名稱、信心程度或假設格式錯誤。");
    }
    for (const key of ["estimated_weight_g", ...NUTRIENT_KEYS]) {
      if (typeof item[key] !== "number" || !Number.isFinite(item[key]) || item[key] < 0) {
        throw new Error(`Gemini 回傳 ${item.name} 的 ${key} 不是有效的非負數字。`);
      }
    }
  }
  return value;
}

export function parseGeminiPayload(payload) {
  if (payload?.promptFeedback?.blockReason) throw new Error("Gemini 封鎖了此請求，請檢查照片及 prompt。");
  const candidate = payload?.candidates?.[0];
  if (!candidate || candidate.finishReason !== "STOP") {
    throw new Error(`Gemini 未完整回覆（${candidate?.finishReason || "沒有候選回覆"}），未產生營養報告。`);
  }
  const text = (candidate.content?.parts ?? [])
    .filter(part => !part.thought && typeof part.text === "string")
    .map(part => part.text)
    .join("");
  let analysis;
  try { analysis = JSON.parse(text); }
  catch { throw new Error("Gemini 未回傳有效 JSON，請重新計算。"); }
  return validateAnalysis(analysis);
}

function splitItemsInstruction(splitItems) {
  return splitItems
    ? "細項拆分已開啟：必須將畫面中可辨識且可分開估算的食物各自列為一個 item。不可只用組合餐名稱概括整盤；例如魚排咖哩應拆成炸魚排、咖哩醬、白飯、玉米筍、荷包蛋等實際可見細項。烹調油可併入所屬食物，避免同一成分重複計算。"
    : "細項拆分已關閉：可以把屬於同一道料理且通常一起食用的內容合併為一個 item，但仍不可重複計算。";
}

function buildBody(images, mealType, mealNote, prompt, splitItems) {
  const photoParts = images.flatMap((image, index) => [
    { text: `照片 ${index}（檔名：${image.name}）` },
    { inlineData: { mimeType: image.mimeType, data: image.dataBase64 } },
  ]);
  const text = `${prompt}\n\n用餐時段：${MEAL_LABELS.get(mealType)}\n共用餐次備註：\n${mealNote || "（沒有文字說明，請依照片估算。）"}\n\n${splitItemsInstruction(splitItems)}\n\n請整合同一餐的全部照片；一般商品照與營養成分標示照若屬同一品項，只計算一次，並依 include_in_report 規則決定報告選圖。`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [{ role: "user", parts: [...photoParts, { text }] }],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: RESPONSE_SCHEMA,
      maxOutputTokens: 16384,
    },
  };
  if (new TextEncoder().encode(JSON.stringify(body)).byteLength > MAX_REQUEST_BYTES) {
    throw new Error(`${MEAL_LABELS.get(mealType)}的照片與文字編碼後超過 Gemini 的請求大小上限，請減少照片或縮小圖片。`);
  }
  return body;
}

function responseHeader(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const wanted = name.toLowerCase();
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === wanted);
  return key ? String(headers[key]).trim() : "";
}

function retryAfterMilliseconds(response, nowImpl) {
  const value = responseHeader(response?.headers, "retry-after");
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - nowImpl()) : 0;
}

function retryDelayMilliseconds(attempt, response, randomImpl, nowImpl) {
  const maximum = Math.min(60_000, 1000 * (2 ** (attempt - 1)));
  const jittered = maximum * (0.5 + 0.5 * randomImpl());
  return Math.round(Math.min(60_000, Math.max(jittered, retryAfterMilliseconds(response, nowImpl))));
}

function httpError(status, attempts) {
  const hints = {
    400: "請確認 API key、模型名稱及圖片格式。",
    401: "API key 無效，請重新建立或複製。",
    403: "請確認 API key 的專案權限、地區與金鑰限制。",
    404: "找不到 Gemini 模型。",
    408: "服務未在期限內完成請求。",
    429: "已達速率或額度限制，請到 AI Studio 檢查配額，稍後再試。",
    500: "Gemini 服務發生暫時性內部錯誤。",
    502: "Gemini 上游服務暫時無法回應。",
    503: "Gemini 模型目前過載或服務暫時無法使用。",
    504: "Gemini 服務回應逾時。",
  };
  const retryable = RETRYABLE_STATUS.has(status);
  const suffix = retryable && attempts > 1 ? `（共嘗試 ${attempts} 次）` : "";
  return new GeminiMobileError(
    `Gemini API HTTP ${status}：${hints[status] || "服務無法完成請求，請稍後再試。"}${suffix}`,
    { retryable, allowFallback: retryable && status !== 429, status },
  );
}

async function nativeRequest(options) {
  return CapacitorHttp.post(options);
}

async function callGemini({
  apiKey,
  model,
  body,
  maxAttempts,
  requestImpl,
  sleepImpl,
  randomImpl,
  nowImpl,
  onProgress,
  imageName,
  signal,
}) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(signal);
    let response;
    try {
      response = await waitForAbortable(requestImpl({
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        data: body,
        connectTimeout: 20_000,
        readTimeout: 60_000,
      }), signal);
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
      if (attempt < maxAttempts) {
        const delayMs = retryDelayMilliseconds(attempt, {}, randomImpl, nowImpl);
        onProgress({ type: "retry", imageName, model, nextAttempt: attempt + 1, maxAttempts, delayMs, reason: "網路連線失敗或請求逾時" });
        await waitForAbortable(sleepImpl(delayMs), signal);
        continue;
      }
      throw new GeminiMobileError(`無法連線至 Gemini（共嘗試 ${attempt} 次）`, { retryable: true, allowFallback: true });
    }

    if (response.status < 200 || response.status >= 300) {
      if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
        const delayMs = retryDelayMilliseconds(attempt, response, randomImpl, nowImpl);
        onProgress({ type: "retry", imageName, model, nextAttempt: attempt + 1, maxAttempts, delayMs, reason: `HTTP ${response.status}` });
        await waitForAbortable(sleepImpl(delayMs), signal);
        continue;
      }
      throw httpError(response.status, attempt);
    }

    let payload = response.data;
    throwIfAborted(signal);
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); }
      catch { throw new Error("Gemini API 回傳了無法解析的 JSON。"); }
    }
    return parseGeminiPayload(payload);
  }
  throw new Error("Gemini 重試流程異常結束。");
}

async function sha256(text) {
  if (!globalThis.crypto?.subtle) throw new Error("此裝置不支援安全摘要，無法建立照片快取。");
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function createAnalysisFingerprint(images, { prompt, mealType, mealNote, splitItems = true, models = [PRIMARY_MODEL, FALLBACK_MODEL] }) {
  return sha256(JSON.stringify({
    version: 5,
    prompt,
    models,
    mealType,
    mealNote,
    splitItems,
    images: images.map(image => ({ name: image.name, mimeType: image.mimeType, dataBase64: image.dataBase64 })),
  }));
}

function readCache(key) {
  const entry = memoryCache.get(key);
  if (!entry) return null;
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  return entry;
}

function writeCache(key, entry) {
  memoryCache.delete(key);
  memoryCache.set(key, entry);
  while (memoryCache.size > MAX_CACHE_ENTRIES) memoryCache.delete(memoryCache.keys().next().value);
}

function validateAssessmentCoverage(analysis, photoCount) {
  if (!Array.isArray(analysis.photo_assessments) || analysis.photo_assessments.length !== photoCount) {
    throw new Error("Gemini 回傳的照片判斷數量與本餐照片不一致。");
  }
  const indexes = new Set(analysis.photo_assessments.map(item => item.photo_index));
  if (indexes.size !== photoCount || [...indexes].some(index => index < 0 || index >= photoCount)) {
    throw new Error("Gemini 回傳的照片編號不完整。");
  }
}

function resultFromMealAnalysis(images, mealType, mealNote, analysis, model, reused) {
  validateAssessmentCoverage(analysis, images.length);
  const assessments = [...analysis.photo_assessments].sort((first, second) => first.photo_index - second.photo_index);
  const preferred = assessments.find(item => item.role === "product_front")
    || assessments.find(item => item.role !== "nutrition_label" && item.role !== "other")
    || assessments[0];
  const sourcePhoto = preferred ? images[preferred.photo_index]?.name : "文字備註";
  const items = analysis.items.map((item, itemIndex) => ({
    ...item,
    source_photo: sourcePhoto,
    source_item_index: itemIndex,
  }));
  const photos = images.map((image, index) => {
    const assessment = assessments[index];
    return {
      name: image.name,
      mealType,
      model,
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
  const meal = {
    id: mealType,
    label: MEAL_LABELS.get(mealType),
    note: mealNote,
    photoCount: images.length,
    items,
    totals: calculateTotals(items),
    uncertainty_notes: analysis.uncertainty_notes.map(note => ({ photo: sourcePhoto, note })),
  };
  return { photos, meals: [meal], totals: meal.totals };
}

export function mergeAnalysisResults(results, date) {
  const validResults = Array.isArray(results) ? results.filter(result => result && Array.isArray(result.photos)) : [];
  const photos = validResults.flatMap(result => result.photos);
  const mealResults = validResults.flatMap(result => Array.isArray(result.meals) ? result.meals : []);
  const meals = MEALS.flatMap(definition => {
    const meal = mealResults.find(candidate => candidate.id === definition.id);
    return meal ? [meal] : [];
  });
  const requestedModels = [...new Set(validResults
    .map(result => result.requestedModel)
    .filter(model => typeof model === "string" && model))];
  const usedModels = [...new Set(validResults.flatMap(result => Array.isArray(result.model) ? result.model : [result.model]).filter(Boolean))];
  const merged = {
    model: usedModels.length === 1 ? usedModels[0] : usedModels,
    requestedModel: requestedModels.length === 1 ? requestedModels[0] : requestedModels,
    photos,
    meals,
    totals: calculateTotals(meals.flatMap(meal => meal.items || [])),
    cache: {
    reused: validResults.reduce((sum, result) => sum + (Number.isInteger(result.cache?.reused) ? result.cache.reused : 0), 0),
      analyzed: validResults.reduce((sum, result) => sum + (Number.isInteger(result.cache?.analyzed) ? result.cache.analyzed : 1), 0),
    },
  };
  if (typeof date === "string") merged.date = date;
  return merged;
}

export async function analyzeImagesOnDevice({
  images,
  mealType,
  mealNote = "",
  cachedMealAnalysis = null,
  force = false,
  splitItems = true,
  apiKey,
  prompt,
  onProgress = () => {},
  models = [PRIMARY_MODEL, FALLBACK_MODEL],
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  requestImpl = nativeRequest,
  sleepImpl = sleep,
  randomImpl = Math.random,
  nowImpl = Date.now,
  signal,
}) {
  if (!apiKey?.trim()) throw new Error("請先填入自己的 Google AI Studio API key。");
  if (!Array.isArray(images)) throw new Error("餐次照片格式錯誤。");
  if (images.length > MAX_IMAGES_PER_MEAL) throw new Error(`每餐最多只能分析 ${MAX_IMAGES_PER_MEAL} 張照片。`);
  const resolvedMealType = mealType || images[0]?.mealType;
  if (!MEAL_LABELS.has(resolvedMealType)) throw new Error("餐次不支援。");
  if (images.some(image => image.mealType !== resolvedMealType)) throw new Error("同一次分析只能包含一個餐次。");
  if (!images.length && !mealNote.trim()) throw new Error("請加入照片或填寫餐次備註。");
  if (!prompt?.trim()) throw new Error("App 內建的營養分析 prompt 不完整。");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts 必須是大於零的整數。");

  throwIfAborted(signal);
  const normalizedNote = mealNote.trim();
  const fingerprint = await createAnalysisFingerprint(images, {
    prompt: prompt.trim(), mealType: resolvedMealType, mealNote: normalizedNote, splitItems, models,
  });
  throwIfAborted(signal);
  let cached = force ? null : (cachedMealAnalysis?.fingerprint === fingerprint && cachedMealAnalysis.analysis
    ? cachedMealAnalysis
    : readCache(fingerprint));
  const wasReused = Boolean(cached);

  if (!cached) {
    onProgress({ type: "analyzing", imageName: MEAL_LABELS.get(resolvedMealType), index: 0, total: 1 });
    const body = buildBody(images, resolvedMealType, normalizedNote, prompt.trim(), splitItems);
    let analysis;
    let actualModel = models[0];
    for (let modelIndex = 0; modelIndex < models.length; modelIndex += 1) {
      actualModel = models[modelIndex];
      try {
        analysis = await callGemini({
          apiKey: apiKey.trim(), model: actualModel, body, maxAttempts, requestImpl,
          sleepImpl, randomImpl, nowImpl, onProgress, imageName: MEAL_LABELS.get(resolvedMealType), signal,
        });
        throwIfAborted(signal);
        break;
      } catch (error) {
        const hasFallback = modelIndex + 1 < models.length;
        if (!(error instanceof GeminiMobileError) || !error.allowFallback || !hasFallback) throw error;
        onProgress({ type: "fallback", imageName: MEAL_LABELS.get(resolvedMealType), model: actualModel, nextModel: models[modelIndex + 1] });
      }
    }
    validateAssessmentCoverage(analysis, images.length);
    cached = { fingerprint, analysis, model: actualModel };
    writeCache(fingerprint, cached);
  } else {
    onProgress({ type: "reused", imageName: MEAL_LABELS.get(resolvedMealType), index: 0, total: 1 });
  }

  images.forEach(image => {
    image.analysisFingerprint = fingerprint;
    image.cachedAnalysis = cached;
  });
  return {
    model: cached.model,
    requestedModel: models[0],
    ...resultFromMealAnalysis(images, resolvedMealType, normalizedNote, cached.analysis, cached.model, wasReused),
    cache: { reused: wasReused ? 1 : 0, analyzed: wasReused ? 0 : 1 },
    mealCache: cached,
  };
}
