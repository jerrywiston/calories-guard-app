const DATABASE_NAME = "calories-guard-static-web-v1";
const DATABASE_VERSION = 1;
const HISTORY_STORE = "history";
const REPORT_STORE = "reports";
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/u;

export function isStaticHostedWeb(locationLike = globalThis.location) {
  if (!locationLike) return false;
  const hostname = String(locationLike.hostname || "").toLowerCase();
  const parameters = new URLSearchParams(String(locationLike.search || ""));
  return hostname.endsWith(".github.io") || parameters.get("static") === "1";
}

function databaseFactory() {
  if (!globalThis.indexedDB) throw new Error("這個瀏覽器不支援 IndexedDB，無法保存歷史紀錄。");
  return globalThis.indexedDB;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), { once: true });
    request.addEventListener("error", () => reject(request.error || new Error("IndexedDB 操作失敗。")), { once: true });
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", resolve, { once: true });
    transaction.addEventListener("abort", () => reject(transaction.error || new Error("IndexedDB 交易已中止。")), { once: true });
    transaction.addEventListener("error", () => reject(transaction.error || new Error("IndexedDB 交易失敗。")), { once: true });
  });
}

async function openDatabase() {
  const request = databaseFactory().open(DATABASE_NAME, DATABASE_VERSION);
  request.addEventListener("upgradeneeded", () => {
    const database = request.result;
    if (!database.objectStoreNames.contains(HISTORY_STORE)) database.createObjectStore(HISTORY_STORE, { keyPath: "date" });
    if (!database.objectStoreNames.contains(REPORT_STORE)) database.createObjectStore(REPORT_STORE, { keyPath: "date" });
  });
  return requestResult(request);
}

function assertDate(date) {
  if (typeof date !== "string" || !DATE_KEY.test(date)) throw new Error("紀錄日期格式不正確。");
}

function normalizeHistoryRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("歷史紀錄格式不正確。");
  assertDate(record.date);
  if (!Array.isArray(record.images) || record.images.length > 30) throw new Error(`${record.date} 的照片資料不正確。`);
  if (!record.mealNotes || typeof record.mealNotes !== "object" || Array.isArray(record.mealNotes)) {
    throw new Error(`${record.date} 的餐次備註不正確。`);
  }
  if (!Object.hasOwn(record, "result")) throw new Error(`${record.date} 缺少營養分析欄位。`);
  return {
    version: 3,
    date: record.date,
    savedAt: typeof record.savedAt === "string" ? record.savedAt : new Date().toISOString(),
    images: record.images,
    mealNotes: record.mealNotes,
    mealAnalysisCache: record.mealAnalysisCache && typeof record.mealAnalysisCache === "object"
      ? record.mealAnalysisCache
      : {},
    result: record.result ?? null,
  };
}

async function withStore(storeName, mode, operation) {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(storeName, mode);
    const completed = transactionComplete(transaction);
    const value = await operation(transaction.objectStore(storeName));
    await completed;
    return value;
  } finally {
    database.close();
  }
}

export async function saveStaticHistoryRecord(record) {
  const normalized = normalizeHistoryRecord(record);
  await withStore(HISTORY_STORE, "readwrite", store => requestResult(store.put(normalized)));
}

export async function deleteStaticHistoryRecord(date) {
  assertDate(date);
  await withStore(HISTORY_STORE, "readwrite", store => requestResult(store.delete(date)));
}

export async function readStaticHistoryRecord(date) {
  assertDate(date);
  return withStore(HISTORY_STORE, "readonly", store => requestResult(store.get(date)));
}

export async function listStaticHistoryRecords() {
  return withStore(HISTORY_STORE, "readonly", store => requestResult(store.getAll()));
}

export async function listStaticHistoryDates() {
  const keys = await withStore(HISTORY_STORE, "readonly", store => requestResult(store.getAllKeys()));
  return keys.filter(key => typeof key === "string" && DATE_KEY.test(key)).sort().reverse();
}

export async function saveStaticReport(date, image) {
  assertDate(date);
  if (!(image?.blob instanceof Blob)) throw new Error("報告圖片格式不正確。");
  await withStore(REPORT_STORE, "readwrite", store => requestResult(store.put({
    date,
    blob: image.blob,
    fileName: image.fileName,
    mimeType: image.mimeType || image.blob.type || "image/jpeg",
    savedAt: new Date().toISOString(),
  })));
}

export async function readStaticReport(date) {
  assertDate(date);
  return withStore(REPORT_STORE, "readonly", store => requestResult(store.get(date)));
}

export async function deleteStaticReport(date) {
  assertDate(date);
  await withStore(REPORT_STORE, "readwrite", store => requestResult(store.delete(date)));
}

export function createStaticBackup(records, exportedAt = new Date().toISOString()) {
  if (!Array.isArray(records)) throw new Error("無法建立備份資料。");
  return {
    format: "calories-guard-history-backup",
    version: 1,
    exportedAt,
    records: records.map(normalizeHistoryRecord),
  };
}

export function validateStaticBackup(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.format !== "calories-guard-history-backup" || value.version !== 1
    || !Array.isArray(value.records)) {
    throw new Error("這不是有效的餐盤小幫手備份檔。");
  }
  const records = value.records.map(normalizeHistoryRecord);
  if (new Set(records.map(record => record.date)).size !== records.length) throw new Error("備份內含重複日期。");
  return records;
}

export async function importStaticBackup(value) {
  const records = validateStaticBackup(value);
  for (const record of records) await saveStaticHistoryRecord(record);
  return records.length;
}
