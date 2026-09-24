import assert from "node:assert/strict";
import { test } from "node:test";
import { deleteDeviceHistoryRecord, listDeviceHistoryDates } from "../public/device-history.js";

test("已存在的 Android 歷史資料夾不會再次建立", async () => {
  let mkdirCalls = 0;
  const dates = await listDeviceHistoryDates({
    directory: "DATA",
    filesystem: {
      readdir: async () => ({ files: [
        { name: "2026-09-21.json" },
        { name: "2026-09-19.json" },
        { name: "readme.txt" },
      ] }),
      mkdir: async () => { mkdirCalls += 1; },
    },
  });

  assert.equal(mkdirCalls, 0);
  assert.deepEqual(dates, ["2026-09-21", "2026-09-19"]);
});

test("歷史資料夾不存在時建立後重新讀取", async () => {
  let reads = 0;
  let mkdirCalls = 0;
  const dates = await listDeviceHistoryDates({
    directory: "DATA",
    filesystem: {
      readdir: async () => {
        reads += 1;
        if (reads === 1) throw new Error("Directory does not exist");
        return { files: [] };
      },
      mkdir: async options => {
        mkdirCalls += 1;
        assert.equal(options.recursive, true);
      },
    },
  });

  assert.equal(reads, 2);
  assert.equal(mkdirCalls, 1);
  assert.deepEqual(dates, []);
});

test("Android 回報資料夾剛被建立時略過 already exists 錯誤", async () => {
  let reads = 0;
  const dates = await listDeviceHistoryDates({
    directory: "DATA",
    filesystem: {
      readdir: async () => {
        reads += 1;
        if (reads === 1) throw new Error("Directory does not exist");
        return { files: [{ name: "2026-09-20.json" }] };
      },
      mkdir: async () => {
        const error = new Error("Directory at '/files/history/' already exists, cannot be overwritten.");
        error.code = "OS-PLUG-FILE-0010";
        throw error;
      },
    },
  });

  assert.deepEqual(dates, ["2026-09-20"]);
});

test("空白日期會刪除 Android 裝置上的當日 JSON", async () => {
  const calls = [];
  const deleted = await deleteDeviceHistoryRecord({
    filesystem: { deleteFile: async options => calls.push(options) },
    directory: "DATA",
    date: "2026-09-21",
  });
  assert.equal(deleted, true);
  assert.deepEqual(calls, [{ path: "history/2026-09-21.json", directory: "DATA" }]);
});

test("刪除不存在的 Android 空白日期視為完成", async () => {
  const deleted = await deleteDeviceHistoryRecord({
    filesystem: { deleteFile: async () => {
      const error = new Error("'deleteFile' failed because file at 'history/2026-09-21.json' does not exist.");
      error.code = "OS-PLUG-FILE-0008";
      throw error;
    } },
    directory: "DATA",
    date: "2026-09-21",
  });
  assert.equal(deleted, false);
});
