import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createStaticBackup,
  isStaticHostedWeb,
  validateStaticBackup,
} from "../public/static-web-storage.js";

function record(date = "2026-09-24") {
  return {
    version: 3,
    date,
    savedAt: "2026-09-24T00:00:00.000Z",
    images: [],
    mealNotes: { breakfast: "燕麥一碗" },
    mealAnalysisCache: {},
    result: null,
  };
}

test("只有 github.io 或明確測試參數啟用靜態網站模式", () => {
  assert.equal(isStaticHostedWeb({ hostname: "sample.github.io", search: "" }), true);
  assert.equal(isStaticHostedWeb({ hostname: "127.0.0.1", search: "?static=1" }), true);
  assert.equal(isStaticHostedWeb({ hostname: "127.0.0.1", search: "" }), false);
  assert.equal(isStaticHostedWeb({ hostname: "github.io.example.com", search: "" }), false);
});

test("靜態網站備份不包含 API key 且可通過格式驗證", () => {
  const backup = createStaticBackup([record()], "2026-09-24T01:00:00.000Z");
  assert.equal(backup.format, "calories-guard-history-backup");
  assert.equal(backup.records.length, 1);
  assert.equal(JSON.stringify(backup).includes("apiKey"), false);
  assert.deepEqual(validateStaticBackup(backup), backup.records);
});

test("拒絕錯誤格式、重複日期與超過每日上限的備份", () => {
  assert.throws(() => validateStaticBackup({ records: [] }), /不是有效/);
  assert.throws(() => validateStaticBackup({
    format: "calories-guard-history-backup", version: 1, records: [record(), record()],
  }), /重複日期/);
  assert.throws(() => validateStaticBackup({
    format: "calories-guard-history-backup", version: 1,
    records: [{ ...record(), images: Array.from({ length: 31 }, () => ({})) }],
  }), /照片資料不正確/);
});
