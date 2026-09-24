import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compactItemLines,
  containedPhotoLayout,
  dailyPhotoLayout,
  dailyReportLayout,
  equalPhotoLayout,
  flexibleMealLayout,
  inlineUnitX,
  normalizedReportCropBox,
  orderReportEntries,
  optimizedDailyPhotoLayout,
  photoAreaWeight,
  reportCropAspectRatio,
  reportPixelDimensions,
  reportTargetStatus,
  skylineMealLayout,
} from "../public/report-export.js";

test("報告輸出固定 1440px 短邊並等比例提高解析度", () => {
  assert.deepEqual(reportPixelDimensions(1080, 2400), { width: 1440, height: 3200, scale: 4 / 3 });
  assert.deepEqual(reportPixelDimensions(1800, 900), { width: 2880, height: 1440, scale: 1.6 });
});

const proportionalTextContext = {
  font: "",
  measureText: text => ({ width: Array.from(String(text)).length * 10 }),
};

test("報告熱量單位會依數字實際寬度向右排列", () => {
  const shortValueX = inlineUnitX(proportionalTextContext, 99, 34);
  const longValueX = inlineUnitX(proportionalTextContext, 12345.6, 34);
  assert.ok(longValueX > shortValueX);
  assert.equal(longValueX, 128);
});

test("報告建議值比較使用百分比與剩餘或超出數量", () => {
  assert.equal(reportTargetStatus(1500, 2000, "kcal"), "達 75% · 還可吃 500 kcal");
  assert.equal(reportTargetStatus(2200, 2000, "kcal"), "達 110% · 超出 200 kcal");
  assert.equal(reportTargetStatus(2000, 2000, "kcal"), "達 100% · 已達建議值");
  assert.equal(reportTargetStatus(1500, undefined, "kcal"), "");
});

test("報告完整列出所有品項且長名稱換行而不省略", () => {
  const items = [
    { name: "雞胸肉" }, { name: "糙米飯" }, { name: "花椰菜" }, { name: "無糖豆漿" },
    { name: "非常非常長而且不能被省略的完整營養品項名稱" },
  ];
  const lines = compactItemLines(proportionalTextContext, items, 100);
  const rendered = lines.join("");
  for (const item of items) assert.ok(rendered.includes(item.name));
  assert.equal(rendered.includes("另有"), false);
  assert.equal(rendered.includes("…"), false);
});

function intersects(first, second) {
  return first.x < second.x + second.width && first.x + first.width > second.x
    && first.y < second.y + second.height && first.y + first.height > second.y;
}

test("Gemini 裁切框加入安全留白並在低信心時保留完整照片", () => {
  assert.deepEqual(
    normalizedReportCropBox({ top: 200, left: 250, bottom: 800, right: 750, confidence: "high" }, 0.1),
    { top: 140, left: 200, bottom: 860, right: 800 },
  );
  assert.deepEqual(
    normalizedReportCropBox({ top: 200, left: 250, bottom: 800, right: 750, confidence: "low" }),
    { top: 0, left: 0, bottom: 1000, right: 1000 },
  );
  assert.deepEqual(
    normalizedReportCropBox({ top: 500, left: 500, bottom: 500, right: 700, confidence: "high" }),
    { top: 0, left: 0, bottom: 1000, right: 1000 },
  );
});

test("同一品項同時有商品照與營養標示照時報告略過標示照", () => {
  const entries = orderReportEntries([
    { resultPhoto: { name: "label.jpg", role: "nutrition_label", subject_identity: "豆漿營養標示", include_in_report: false } },
    { resultPhoto: { name: "food.jpg", role: "food", subject_identity: "三明治", include_in_report: true } },
    { resultPhoto: { name: "front.jpg", role: "product_front", subject_identity: "無糖豆漿", include_in_report: true } },
  ]);
  assert.deepEqual(entries.map(entry => entry.resultPhoto.name), ["front.jpg", "food.jpg"]);
});

test("沒有對應商品照的營養標示仍保留在報告", () => {
  const entries = orderReportEntries([
    { resultPhoto: { name: "drink-front.jpg", role: "product_front", subject_identity: "無糖豆漿", include_in_report: true } },
    { resultPhoto: { name: "snack-label.jpg", role: "nutrition_label", subject_identity: "燕麥棒", include_in_report: true } },
    { resultPhoto: { name: "unknown-label.jpg", role: "nutrition_label", subject_identity: "無法確認", include_in_report: true } },
  ]);
  assert.deepEqual(entries.map(entry => entry.resultPhoto.name), ["drink-front.jpg", "snack-label.jpg", "unknown-label.jpg"]);
});

test("報告排版使用裁切後的照片比例", () => {
  const originalRatio = reportCropAspectRatio(1200, 800);
  const croppedRatio = reportCropAspectRatio(1200, 800, {
    top: 100, left: 300, bottom: 900, right: 700, confidence: "medium",
  });
  assert.equal(originalRatio, 1.5);
  assert.ok(croppedRatio < 1, "裁掉橫向背景後應視為直式照片");
});

test("手機報告的一到四張照片保持等面積且不互相重疊", () => {
  const width = 932;
  const height = 720;
  for (let count = 1; count <= 4; count += 1) {
    const layout = equalPhotoLayout(count, width, height, 16);
    assert.equal(layout.length, count);
    const areas = layout.map(rect => rect.width * rect.height);
    assert.ok(Math.max(...areas) - Math.min(...areas) < 0.001, `${count} 張照片的顯示面積應相同`);
    for (const rect of layout) {
      assert.ok(rect.x >= 0 && rect.y >= 0);
      assert.ok(rect.x + rect.width <= width + 0.001);
      assert.ok(rect.y + rect.height <= height + 0.001);
    }
    for (let first = 0; first < layout.length; first += 1) {
      for (let second = first + 1; second < layout.length; second += 1) {
        assert.equal(intersects(layout[first], layout[second]), false);
      }
    }
  }
});

test("手機報告拒絕在同一頁放超過四張照片", () => {
  assert.throws(() => equalPhotoLayout(0, 932, 720), /1 到 4/);
  assert.throws(() => equalPhotoLayout(5, 932, 720), /1 到 4/);
});

test("完整顯示照片時會依橫式或直式比例選擇較密的等面積排列", () => {
  const landscape = containedPhotoLayout([1.8, 1.8], 932, 720, 16);
  assert.ok(landscape[0].width > landscape[0].height, "橫式照片應排列成上下兩格");
  const portrait = containedPhotoLayout([0.55, 0.55], 932, 720, 16);
  assert.ok(portrait[0].height > portrait[0].width, "直式照片應排列成左右兩格");
  for (const layout of [landscape, portrait]) {
    const areas = layout.map(rect => rect.width * rect.height);
    assert.ok(Math.max(...areas) - Math.min(...areas) < 0.001);
  }
});

test("全天報告每餐一到十張照片都維持可辨識尺寸", () => {
  for (let count = 1; count <= 10; count += 1) {
    const { rects, height } = dailyPhotoLayout(count, 912, 16);
    assert.equal(rects.length, count);
    assert.ok(height > 0);
    assert.ok(Math.min(...rects.map(rect => Math.min(rect.width, rect.height))) >= 280);
    for (const rect of rects) {
      assert.ok(rect.x >= 0 && rect.y >= 0);
      assert.ok(rect.x + rect.width <= 912.001);
      assert.ok(rect.y + rect.height <= height + 0.001);
    }
  }
});

test("十張照片會使用有限候選搜尋並保持比例、邊界與不重疊", () => {
  const ratios = [1.7, 0.6, 1, 1.3, 0.75, 1.8, 0.55, 1.1, 0.9, 1.5];
  const layout = optimizedDailyPhotoLayout(ratios, 912, 16, {
    itemCounts: [4, 1, 2, 3, 1, 5, 1, 2, 1, 3],
    minimumShortEdge: 100,
  });
  assert.equal(layout.rects.length, 10);
  layout.rects.forEach((rect, index) => {
    assert.ok(Math.abs(rect.width / rect.height - ratios[index]) < 0.001);
    assert.ok(rect.x >= -0.001 && rect.y >= -0.001);
    assert.ok(rect.x + rect.width <= 912.001);
    assert.ok(rect.y + rect.height <= layout.height + 0.001);
  });
  for (let first = 0; first < layout.rects.length; first += 1) {
    for (let second = first + 1; second < layout.rects.length; second += 1) {
      assert.equal(intersects(layout.rects[first], layout.rects[second]), false);
    }
  }
});

test("全天報告依照片比例搜尋等面積且不裁切的緊密排列", () => {
  const ratios = [1.78, 0.56, 1, 1.4, 0.7, 1.78];
  const layout = optimizedDailyPhotoLayout(ratios, 912, 16);
  assert.equal(layout.rects.length, ratios.length);
  assert.ok(layout.minimumDisplayedEdge >= 240);
  const areas = layout.rects.map(rect => rect.width * rect.height);
  assert.ok(Math.max(...areas) - Math.min(...areas) < 0.01, "所有照片應維持同等視覺面積");
  layout.rects.forEach((rect, index) => {
    assert.ok(Math.abs(rect.width / rect.height - ratios[index]) < 0.001, "照片格應符合原始比例");
    assert.ok(rect.x >= -0.001 && rect.y >= -0.001);
    assert.ok(rect.x + rect.width <= 912.001);
    assert.ok(rect.y + rect.height <= layout.height + 0.001);
  });
  for (let first = 0; first < layout.rects.length; first += 1) {
    for (let second = first + 1; second < layout.rects.length; second += 1) {
      assert.equal(intersects(layout.rects[first], layout.rects[second]), false);
    }
  }
});

test("全天報告依每張照片的品項數分配顯示面積", () => {
  const layout = optimizedDailyPhotoLayout([1, 1], 912, 16, { itemCounts: [5, 1] });
  const areas = layout.rects.map(rect => rect.width * rect.height);
  assert.equal(photoAreaWeight(1), 1);
  assert.equal(photoAreaWeight(5), 2.8);
  assert.ok(Math.abs(areas[0] / areas[1] - 2.8) < 0.001);
  assert.ok(layout.rects[0].width > layout.rects[1].width);
  assert.ok(layout.rects[0].height > layout.rects[1].height);
  assert.equal(intersects(layout.rects[0], layout.rects[1]), false);
});

test("比例最佳化排列比固定格線使用更多有效照片面積", () => {
  const ratios = [1.78, 0.56, 1, 1.4, 0.7, 1.78];
  const fixed = dailyPhotoLayout(ratios.length, 912, 16);
  const fixedPhotoArea = fixed.rects.reduce((sum, rect, index) => {
    const ratio = ratios[index];
    const scale = Math.min(rect.width / ratio, rect.height);
    return sum + ratio * scale * scale;
  }, 0);
  const optimized = optimizedDailyPhotoLayout(ratios, 912, 16);
  const fixedEfficiency = fixedPhotoArea / (912 * fixed.height);
  const optimizedEfficiency = optimized.rects.reduce((sum, rect) => sum + rect.width * rect.height, 0)
    / (912 * optimized.height);
  assert.ok(optimizedEfficiency > fixedEfficiency + 0.1);
});

test("Skyline 會讓窄早餐與午餐並排並利用較短餐卡下方空間", () => {
  const layout = skylineMealLayout([
    [{ width: 300, height: 420 }],
    [{ width: 642, height: 800 }],
    [{ width: 300, height: 250 }],
  ], 960, 18);
  assert.deepEqual(layout.placements.map(({ x, y, width }) => ({ x, y, width })), [
    { x: 0, y: 0, width: 300 },
    { x: 318, y: 0, width: 642 },
    { x: 0, y: 438, width: 300 },
  ]);
  assert.equal(layout.height, 800, "第三餐應填入早餐下方，不再增加報告高度");
});

test("Skyline 動態餐卡維持時間順序且不重疊", () => {
  const layout = skylineMealLayout([
    [{ width: 300, height: 620 }, { width: 960, height: 400 }],
    [{ width: 642, height: 700 }, { width: 960, height: 500 }],
    [{ width: 456, height: 250 }, { width: 960, height: 180 }],
  ], 960, 18);
  for (let index = 1; index < layout.placements.length; index += 1) {
    const previous = layout.placements[index - 1];
    const current = layout.placements[index];
    assert.ok(current.y > previous.y || (current.y === previous.y && current.x > previous.x));
  }
  for (let first = 0; first < layout.placements.length; first += 1) {
    for (let second = first + 1; second < layout.placements.length; second += 1) {
      assert.equal(intersects(layout.placements[first], layout.placements[second]), false);
    }
  }
});

test("彈性二維背包只固定早午晚順序，下午茶與宵夜可插入空隙", () => {
  const mealIds = ["breakfast", "lunch", "afternoon_tea", "dinner", "late_night"];
  const layout = flexibleMealLayout([
    [{ width: 720, height: 460 }],
    [{ width: 240, height: 180 }],
    [{ width: 400, height: 680 }],
    [{ width: 400, height: 380 }],
    [{ width: 480, height: 680 }],
  ], mealIds, 960, 18);

  assert.notDeepEqual(layout.order, [0, 1, 2, 3, 4]);
  assert.deepEqual(
    layout.order.map(index => mealIds[index]).filter(id => ["breakfast", "lunch", "dinner"].includes(id)),
    ["breakfast", "lunch", "dinner"],
  );
  assert.ok(layout.order.indexOf(4) < layout.order.indexOf(3), "宵夜應可移到晚餐前方填補版面");
  for (let first = 0; first < layout.placements.length; first += 1) {
    for (let second = first + 1; second < layout.placements.length; second += 1) {
      assert.equal(intersects(layout.placements[first], layout.placements[second]), false);
    }
  }
});

test("全天報告最後一餐與頁尾保有獨立空間", () => {
  const layout = dailyReportLayout([2, 3, 1, 6]);
  assert.equal(layout.mealRects.length, 4);
  for (let index = 1; index < layout.mealRects.length; index += 1) {
    assert.ok(layout.mealRects[index].y > layout.mealRects[index - 1].bottom);
  }
  const lastMeal = layout.mealRects.at(-1);
  assert.ok(layout.footerTop - lastMeal.bottom >= 40, "頁尾不得覆蓋最後一餐");
  assert.ok(layout.height > layout.footerTop);
});
