import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeImagesOnDevice, mergeAnalysisResults, validateAnalysis } from "../public/mobile-gemini.js";

function analysis(name = "烤雞胸", photoCount = 1) {
  return {
    is_food: true,
    meal_name: "雞胸餐",
    items: [{
      name,
      estimated_weight_g: 120,
      calories_kcal: 198,
      protein_g: 37,
      fat_g: 4.3,
      carbs_g: 0,
      fiber_g: 0,
      sugar_g: 0,
      sodium_mg: 88,
      confidence: "medium",
      assumptions: ["以熟重估算"],
    }],
    uncertainty_notes: ["未計入額外醬料"],
    report_crop_box: { top: 120, left: 180, bottom: 880, right: 820, confidence: "medium" },
    photo_assessments: Array.from({ length: photoCount }, (_, photo_index) => ({
      photo_index,
      role: photo_index === 0 ? "product_front" : "nutrition_label",
      subject_identity: "測試包裝食品",
      visible_item_count: 1,
      include_in_report: photo_index === 0,
      report_crop_box: { top: 120, left: 180, bottom: 880, right: 820, confidence: "medium" },
    })),
  };
}

function response(value = analysis()) {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    data: {
      candidates: [{
        finishReason: "STOP",
        content: { parts: [{ text: JSON.stringify(value) }] },
      }],
    },
  };
}

function image() {
  return {
    name: "lunch.jpg",
    mimeType: "image/jpeg",
    dataBase64: "AQIDBA==",
    mealType: "lunch",
  };
}

test("手機端拒絕單餐超過十張照片", async () => {
  await assert.rejects(
    analyzeImagesOnDevice({
      images: Array.from({ length: 11 }, (_, index) => ({ ...image(), name: `lunch-${index}.jpg` })),
      mealType: "lunch",
      apiKey: "test-api-key-photo-limit-123456",
      prompt: "測試照片上限",
    }),
    /每餐最多只能分析 10 張照片/,
  );
});

test("手機分析直接以標頭呼叫 Gemini 並統整餐次", async () => {
  const requests = [];
  const result = await analyzeImagesOnDevice({
    images: [image()],
    mealType: "lunch",
    mealNote: "測試-direct",
    apiKey: "test-api-key-direct-123456",
    prompt: "請分析營養",
    requestImpl: async options => { requests.push(options); return response(); },
    sleepImpl: async () => {},
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(requests[0].headers["x-goog-api-key"], "test-api-key-direct-123456");
  assert.equal(requests[0].data.contents[0].parts[1].inlineData.data, "AQIDBA==");
  assert.match(requests[0].data.contents[0].parts.at(-1).text, /用餐時段：午餐/);
  assert.match(requests[0].data.contents[0].parts.at(-1).text, /細項拆分已開啟/);
  assert.match(requests[0].data.systemInstruction.parts[0].text, /不得僅因標示缺項就填 0/);
  assert.ok(requests[0].data.generationConfig.responseJsonSchema.required.includes("report_crop_box"));
  assert.match(requests[0].data.systemInstruction.parts[0].text, /只移除明顯無關背景/);
  assert.equal(result.meals[0].label, "午餐");
  assert.equal(result.meals[0].items[0].source_photo, "lunch.jpg");
  assert.equal(result.totals.calories_kcal, 198);
  assert.deepEqual(result.photos[0].analysis.report_crop_box, {
    top: 120, left: 180, bottom: 880, right: 820, confidence: "medium",
  });
  assert.deepEqual(result.cache, { reused: 0, analyzed: 1 });
  assert.doesNotMatch(JSON.stringify(result), /test-api-key-direct/);
});

test("關閉細項拆分時傳送合併料理指示", async () => {
  let request;
  await analyzeImagesOnDevice({
    images: [image()], mealType: "lunch", mealNote: "魚排咖哩",
    splitItems: false, apiKey: "test-api-key-grouped-123456", prompt: "請分析營養",
    requestImpl: async options => { request = options; return response(); },
  });
  assert.match(request.data.contents[0].parts.at(-1).text, /細項拆分已關閉/);
});

test("同餐正面與營養標示一次送出且只保留 Gemini 去重後的品項", async () => {
  const requests = [];
  const front = { ...image(), name: "front.jpg" };
  const label = { ...image(), name: "label.jpg", dataBase64: "BQYHCA==" };
  const result = await analyzeImagesOnDevice({
    images: [front, label],
    mealType: "lunch",
    mealNote: "同一瓶豆漿的正反面",
    apiKey: "test-api-key-dedup-123456",
    prompt: "分析並去重",
    requestImpl: async options => { requests.push(options); return response(analysis("豆漿", 2)); },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].data.contents[0].parts.filter(part => part.inlineData).length, 2);
  assert.equal(result.meals[0].items.length, 1);
  assert.deepEqual(result.photos.map(photo => photo.role), ["product_front", "nutrition_label"]);
  assert.equal(result.meals[0].items[0].source_photo, "front.jpg");
});

test("沒有照片但有餐次備註時可直接分析並保留文字來源", async () => {
  const textOnly = analysis("鮪魚蛋吐司", 0);
  const result = await analyzeImagesOnDevice({
    images: [],
    mealType: "breakfast",
    mealNote: "鮪魚蛋吐司一份",
    apiKey: "test-api-key-text-only-123456",
    prompt: "依文字估算",
    requestImpl: async options => {
      assert.equal(options.data.contents[0].parts.some(part => part.inlineData), false);
      return response(textOnly);
    },
  });
  assert.equal(result.photos.length, 0);
  assert.equal(result.meals[0].photoCount, 0);
  assert.equal(result.meals[0].note, "鮪魚蛋吐司一份");
  assert.equal(result.meals[0].items[0].source_photo, "文字備註");
});

test("分餐完成後可逐步合併已完成餐次與今日累計", async () => {
  const breakfastImage = { ...image(), name: "breakfast.jpg", mealType: "breakfast" };
  const lunchImage = { ...image(), name: "lunch.jpg", mealType: "lunch" };
  const requestImpl = async options => {
    const text = options.data.contents[0].parts.map(part => part.text || "").join("\n");
    return response(analysis(text.includes("早餐") ? "早餐雞胸" : "午餐雞胸"));
  };
  const breakfast = await analyzeImagesOnDevice({
    images: [breakfastImage], mealType: "breakfast", mealNote: "早餐一份", apiKey: "test-api-key-meals-123456", prompt: "分餐測試", requestImpl,
  });
  const firstDisplay = mergeAnalysisResults([breakfast], "2026-09-21");
  assert.deepEqual(firstDisplay.meals.map(meal => meal.id), ["breakfast"]);
  assert.equal(firstDisplay.totals.calories_kcal, 198);

  const lunch = await analyzeImagesOnDevice({
    images: [lunchImage], mealType: "lunch", mealNote: "午餐一份", apiKey: "test-api-key-meals-123456", prompt: "分餐測試", requestImpl,
  });
  const finalDisplay = mergeAnalysisResults([breakfast, lunch], "2026-09-21");
  assert.deepEqual(finalDisplay.meals.map(meal => meal.id), ["breakfast", "lunch"]);
  assert.equal(finalDisplay.totals.calories_kcal, 396);
  assert.deepEqual(finalDisplay.cache, { reused: 0, analyzed: 2 });
  assert.equal(finalDisplay.date, "2026-09-21");
});

test("照片與備註未變更時沿用結果，變更備註後才重新送出", async () => {
  let calls = 0;
  const requestImpl = async () => { calls += 1; return response(); };
  const firstImage = image();
  const first = await analyzeImagesOnDevice({
    images: [firstImage], apiKey: "test-api-key-cache-123456", prompt: "測試快取",
    mealType: "lunch", mealNote: "測試-cache-a",
    requestImpl, sleepImpl: async () => {},
  });
  const restored = { ...image() };
  const reused = await analyzeImagesOnDevice({
    images: [restored], apiKey: "test-api-key-cache-123456", prompt: "測試快取",
    mealType: "lunch", mealNote: "測試-cache-a", cachedMealAnalysis: first.mealCache,
    requestImpl, sleepImpl: async () => {},
  });
  assert.equal(calls, 1);
  assert.deepEqual(reused.cache, { reused: 1, analyzed: 0 });

  const forced = await analyzeImagesOnDevice({
    images: [restored], apiKey: "test-api-key-cache-123456", prompt: "測試快取",
    mealType: "lunch", mealNote: "測試-cache-a", cachedMealAnalysis: first.mealCache,
    force: true, requestImpl, sleepImpl: async () => {},
  });
  assert.equal(calls, 2);
  assert.deepEqual(forced.cache, { reused: 0, analyzed: 1 });

  const changed = await analyzeImagesOnDevice({
    images: [restored], apiKey: "test-api-key-cache-123456", prompt: "測試快取",
    mealType: "lunch", mealNote: "測試-cache-b", cachedMealAnalysis: first.mealCache,
    requestImpl, sleepImpl: async () => {},
  });
  assert.equal(calls, 3);
  assert.deepEqual(changed.cache, { reused: 0, analyzed: 1 });
});

test("3.1 Flash-Lite 持續 503 時會重試六次再改用備援模型", async () => {
  const models = [];
  const progress = [];
  const result = await analyzeImagesOnDevice({
    images: [image("測試-fallback")],
    apiKey: "test-api-key-fallback-123456",
    prompt: "測試備援",
    requestImpl: async options => {
      const model = decodeURIComponent(options.url.match(/models\/([^:]+):/)?.[1] || "");
      models.push(model);
      return model === "gemini-3.1-flash-lite" ? { status: 503, headers: {}, data: {} } : response();
    },
    sleepImpl: async () => {},
    randomImpl: () => 0,
    onProgress: event => progress.push(event.type),
  });

  assert.deepEqual(models, [...Array(6).fill("gemini-3.1-flash-lite"), "gemini-3.8-flash"]);
  assert.equal(result.model, "gemini-3.8-flash");
  assert.ok(progress.includes("retry"));
  assert.ok(progress.includes("fallback"));
});

test("Gemini 回傳無效 JSON 時拒絕寫入分析結果", async () => {
  await assert.rejects(
    analyzeImagesOnDevice({
      images: [image("測試-invalid-json")],
      apiKey: "test-api-key-invalid-123456",
      prompt: "測試驗證",
      requestImpl: async () => ({
        status: 200,
        headers: {},
        data: { candidates: [{ finishReason: "STOP", content: { parts: [{ text: "not-json" }] } }] },
      }),
      sleepImpl: async () => {},
    }),
    /未回傳有效 JSON/,
  );
});

test("Gemini 回傳空白營養數值時拒絕結果，避免介面留下空值", async () => {
  const invalid = analysis();
  invalid.items[0].sodium_mg = null;
  await assert.rejects(
    analyzeImagesOnDevice({
      images: [image("測試-null-nutrient")],
      apiKey: "test-api-key-null-123456",
      prompt: "測試營養數值驗證",
      requestImpl: async () => response(invalid),
      sleepImpl: async () => {},
    }),
    /不是有效的非負數字/,
  );
});

test("Gemini 回傳顛倒或超出範圍的裁切框時拒絕結果", () => {
  const invalid = analysis();
  invalid.report_crop_box = { top: 900, left: 100, bottom: 200, right: 1100, confidence: "high" };
  assert.throws(() => validateAnalysis(invalid), /裁切框格式錯誤/);
});

test("使用者中止時立即停止等待手機端 Gemini 請求", async () => {
  const controller = new AbortController();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let calls = 0;
  const pending = analyzeImagesOnDevice({
    images: [image("測試-cancel")],
    apiKey: "test-api-key-cancel-123456",
    prompt: "測試中止",
    signal: controller.signal,
    requestImpl: async () => {
      calls += 1;
      markStarted();
      return new Promise(() => {});
    },
  });

  await started;
  controller.abort("user");
  await assert.rejects(pending, error => error?.name === "AbortError");
  assert.equal(calls, 1);
});
