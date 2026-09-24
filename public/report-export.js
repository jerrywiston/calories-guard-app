const REPORT_WIDTH = 1080;
const REPORT_HEIGHT = 1920;
export const REPORT_SHORT_EDGE = 1440;
const PHOTOS_PER_PAGE = 4;
const FONT_FAMILY = '"Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';

export function equalPhotoLayout(count, width, height, gap = 16) {
  if (!Number.isInteger(count) || count < 1 || count > PHOTOS_PER_PAGE) {
    throw new Error("每頁照片數量必須介於 1 到 4 張。");
  }
  if (count === 1) return [{ x: 0, y: 0, width, height }];
  if (count === 2) {
    const itemWidth = (width - gap) / 2;
    return [
      { x: 0, y: 0, width: itemWidth, height },
      { x: itemWidth + gap, y: 0, width: itemWidth, height },
    ];
  }
  if (count === 3) {
    const itemWidth = (width - gap) / 2;
    const itemHeight = (height - gap) / 2;
    return [
      { x: 0, y: 0, width: itemWidth, height: itemHeight },
      { x: itemWidth + gap, y: 0, width: itemWidth, height: itemHeight },
      { x: 0, y: itemHeight + gap, width: itemWidth, height: itemHeight },
    ];
  }
  const itemWidth = (width - gap) / 2;
  const itemHeight = (height - gap) / 2;
  return [
    { x: 0, y: 0, width: itemWidth, height: itemHeight },
    { x: itemWidth + gap, y: 0, width: itemWidth, height: itemHeight },
    { x: 0, y: itemHeight + gap, width: itemWidth, height: itemHeight },
    { x: itemWidth + gap, y: itemHeight + gap, width: itemWidth, height: itemHeight },
  ];
}

function transposeLayout(layout) {
  return layout.map(rect => ({ x: rect.y, y: rect.x, width: rect.height, height: rect.width }));
}

function permutations(values) {
  if (values.length <= 1) return [values];
  return values.flatMap((value, index) => permutations(values.filter((_, itemIndex) => itemIndex !== index))
    .map(rest => [value, ...rest]));
}

export function containedPhotoLayout(aspectRatios, width, height, gap = 16) {
  const count = aspectRatios.length;
  const horizontal = equalPhotoLayout(count, width, height, gap);
  if (count === 1 || count === 3 || count === 4) return horizontal;
  const vertical = transposeLayout(equalPhotoLayout(count, height, width, gap));
  let best = horizontal;
  let bestScore = -1;
  for (const candidate of [horizontal, vertical]) {
    for (const assignment of permutations(candidate)) {
      const score = assignment.reduce((sum, rect, index) => {
        const imageAspect = Number.isFinite(aspectRatios[index]) && aspectRatios[index] > 0 ? aspectRatios[index] : 1;
        const tileAspect = rect.width / rect.height;
        return sum + Math.min(imageAspect / tileAspect, tileAspect / imageAspect);
      }, 0);
      if (score > bestScore) {
        bestScore = score;
        best = assignment;
      }
    }
  }
  return best;
}

function roundedRect(context, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function fillRoundedRect(context, x, y, width, height, radius, color) {
  roundedRect(context, x, y, width, height, radius);
  context.fillStyle = color;
  context.fill();
}

function fitText(context, text, maxWidth) {
  const value = String(text || "");
  if (context.measureText(value).width <= maxWidth) return value;
  let shortened = value;
  while (shortened.length > 1 && context.measureText(`${shortened}…`).width > maxWidth) shortened = shortened.slice(0, -1);
  return `${shortened}…`;
}

function number(value) {
  const safe = typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 1 }).format(safe);
}

export function reportTargetStatus(value, target, unit) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0
    || typeof target !== "number" || !Number.isFinite(target) || target <= 0) return "";
  const percentage = number((value / target) * 100);
  const remaining = target - value;
  if (remaining > 0.05) return `達 ${percentage}% · 還可吃 ${number(remaining)} ${unit}`;
  if (remaining < -0.05) return `達 ${percentage}% · 超出 ${number(Math.abs(remaining))} ${unit}`;
  return `達 ${percentage}% · 已達建議值`;
}

function drawValueAndUnit(context, value, unit, x, y, valueFont, unitFont, color, gap = 14) {
  const text = number(value);
  context.textAlign = "left";
  context.fillStyle = color;
  context.font = valueFont;
  context.fillText(text, x, y);
  const unitX = inlineUnitX(context, value, x, gap);
  context.font = unitFont;
  context.fillText(unit, unitX, y - 3);
}

export function inlineUnitX(context, value, x, gap = 14) {
  return x + context.measureText(number(value)).width + gap;
}

async function decodePhoto(blob) {
  if (!blob) throw new Error("照片內容不存在。");
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("照片無法加入報告。")); };
    image.src = url;
  });
}

const FULL_REPORT_CROP = Object.freeze({ top: 0, left: 0, bottom: 1000, right: 1000 });

export function normalizedReportCropBox(value, paddingRatio = 0.12) {
  if (!value || !["high", "medium"].includes(value.confidence)) return { ...FULL_REPORT_CROP };
  const coordinates = [value.top, value.left, value.bottom, value.right];
  if (coordinates.some(coordinate => typeof coordinate !== "number" || !Number.isFinite(coordinate)
    || coordinate < 0 || coordinate > 1000)
    || value.bottom <= value.top || value.right <= value.left) return { ...FULL_REPORT_CROP };
  const width = value.right - value.left;
  const height = value.bottom - value.top;
  if (width < 50 || height < 50) return { ...FULL_REPORT_CROP };
  const horizontalPadding = width * Math.max(0, paddingRatio);
  const verticalPadding = height * Math.max(0, paddingRatio);
  return {
    top: Math.max(0, value.top - verticalPadding),
    left: Math.max(0, value.left - horizontalPadding),
    bottom: Math.min(1000, value.bottom + verticalPadding),
    right: Math.min(1000, value.right + horizontalPadding),
  };
}

export function reportCropAspectRatio(imageWidth, imageHeight, cropBox) {
  if (!(imageWidth > 0) || !(imageHeight > 0)) return 1;
  const crop = normalizedReportCropBox(cropBox);
  return (imageWidth * (crop.right - crop.left)) / (imageHeight * (crop.bottom - crop.top));
}

function drawPhotoContained(context, image, rect, cropBox) {
  const imageWidth = image.width || image.naturalWidth;
  const imageHeight = image.height || image.naturalHeight;
  const crop = normalizedReportCropBox(cropBox);
  const sourceX = imageWidth * crop.left / 1000;
  const sourceY = imageHeight * crop.top / 1000;
  const sourceWidth = imageWidth * (crop.right - crop.left) / 1000;
  const sourceHeight = imageHeight * (crop.bottom - crop.top) / 1000;
  const scale = Math.min(rect.width / sourceWidth, rect.height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const drawX = rect.x + (rect.width - drawWidth) / 2;
  const drawY = rect.y + (rect.height - drawHeight) / 2;
  context.save();
  roundedRect(context, rect.x, rect.y, rect.width, rect.height, 24);
  context.clip();
  context.fillStyle = "#e8e7e1";
  context.fillRect(rect.x, rect.y, rect.width, rect.height);
  context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, drawX, drawY, drawWidth, drawHeight);
  context.restore();
}

function drawPhotoPlaceholder(context, rect) {
  fillRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 24, "#e5ebe7");
  context.fillStyle = "#66756f";
  context.font = `700 25px ${FONT_FAMILY}`;
  context.textAlign = "center";
  context.fillText("照片無法預覽", rect.x + rect.width / 2, rect.y + rect.height / 2);
}

function drawPhotoBadge(context, rect, numberValue) {
  const x = rect.x + 20;
  const y = rect.y + 20;
  context.beginPath();
  context.arc(x + 25, y + 25, 25, 0, Math.PI * 2);
  context.fillStyle = "rgba(14, 79, 59, .92)";
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `800 25px ${FONT_FAMILY}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(numberValue), x + 25, y + 26);
  context.textBaseline = "alphabetic";
}

function drawMosaicSummary(context, rect, meal, fallbackItemCount) {
  fillRoundedRect(context, rect.x, rect.y, rect.width, rect.height, 24, "#e2f0e9");
  context.textAlign = "left";
  context.fillStyle = "#5f756c";
  context.font = `750 21px ${FONT_FAMILY}`;
  context.fillText("本餐快覽", rect.x + 30, rect.y + 55);
  context.fillStyle = "#0e4f3b";
  context.font = `850 54px ${FONT_FAMILY}`;
  context.fillText(number(meal.totals?.calories_kcal), rect.x + 30, rect.y + 130);
  context.font = `750 21px ${FONT_FAMILY}`;
  context.fillText("kcal", rect.x + 30, rect.y + 164);
  context.fillStyle = "#5f756c";
  context.font = `700 22px ${FONT_FAMILY}`;
  const itemCount = Array.isArray(meal.items) ? meal.items.length : fallbackItemCount;
  context.fillText(`${itemCount} 個營養品項`, rect.x + 30, rect.y + rect.height - 42);
}

function drawItemCard(context, item, index, x, y, width, height) {
  fillRoundedRect(context, x, y, width, height, 18, index % 2 ? "#faf4ec" : "#f2f8f4");
  context.beginPath();
  context.arc(x + 35, y + 34, 18, 0, Math.PI * 2);
  context.fillStyle = "#176b50";
  context.fill();
  context.fillStyle = "#ffffff";
  context.font = `800 19px ${FONT_FAMILY}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(item.photoNumber), x + 35, y + 35);
  context.textBaseline = "alphabetic";
  context.textAlign = "left";
  context.fillStyle = "#18342c";
  context.font = `750 25px ${FONT_FAMILY}`;
  context.fillText(fitText(context, item.name || "未命名品項", width - 190), x + 64, y + 39);
  context.textAlign = "right";
  context.font = `800 23px ${FONT_FAMILY}`;
  context.fillText(`${number(item.calories_kcal)} kcal`, x + width - 22, y + 39);
  context.textAlign = "left";
  context.fillStyle = "#718079";
  context.font = `650 18px ${FONT_FAMILY}`;
  context.fillText(`蛋白 ${number(item.protein_g)}g · 碳水 ${number(item.carbs_g)}g · 脂肪 ${number(item.fat_g)}g`, x + 22, y + 76);
}

function drawOverflowCard(context, hiddenCount, x, y, width, height) {
  fillRoundedRect(context, x, y, width, height, 18, "#f3f1eb");
  context.fillStyle = "#5f6e68";
  context.font = `750 23px ${FONT_FAMILY}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(`另有 ${hiddenCount} 個品項，請在 App 查看`, x + width / 2, y + height / 2);
  context.textBaseline = "alphabetic";
}

function drawMealTotals(context, totals) {
  const x = 74;
  const y = 1472;
  const width = 932;
  const height = 332;
  fillRoundedRect(context, x, y, width, height, 28, "#183f34");
  context.textAlign = "left";
  context.fillStyle = "#c9e3d7";
  context.font = `750 22px ${FONT_FAMILY}`;
  context.fillText("本餐營養總計", x + 34, y + 48);
  drawValueAndUnit(
    context, totals.calories_kcal, "kcal", x + 34, y + 119,
    `850 62px ${FONT_FAMILY}`, `700 23px ${FONT_FAMILY}`, "#ffffff",
  );

  const cells = [
    ["蛋白質", totals.protein_g, "g"], ["碳水", totals.carbs_g, "g"], ["脂肪", totals.fat_g, "g"],
    ["膳食纖維", totals.fiber_g, "g"], ["糖", totals.sugar_g, "g"], ["鈉", totals.sodium_mg, "mg"],
  ];
  const cellWidth = (width - 68) / 3;
  cells.forEach(([label, value, unit], index) => {
    const column = index % 3;
    const row = Math.floor(index / 3);
    const cellX = x + 34 + column * cellWidth;
    const cellY = y + 169 + row * 82;
    context.fillStyle = "#a9cbbb";
    context.font = `700 18px ${FONT_FAMILY}`;
    context.fillText(label, cellX, cellY);
    context.fillStyle = "#ffffff";
    context.font = `800 28px ${FONT_FAMILY}`;
    context.fillText(`${number(value)} ${unit}`, cellX, cellY + 35);
  });
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("瀏覽器無法輸出手機報告圖片。")),
      type,
      quality,
    );
  });
}

async function blobFromCanvas(canvas) {
  const maximumBytes = 2_000_000;
  let smallest = null;
  for (const quality of [0.94, 0.9, 0.86, 0.82, 0.76, 0.7, 0.64, 0.58, 0.52, 0.46]) {
    const blob = await canvasBlob(canvas, "image/jpeg", quality);
    smallest = blob;
    if (blob.size <= maximumBytes) return blob;
  }
  return smallest;
}

export function reportPixelDimensions(logicalWidth, logicalHeight, shortEdge = REPORT_SHORT_EDGE) {
  if (!(logicalWidth > 0) || !(logicalHeight > 0) || !(shortEdge > 0)) {
    throw new Error("報告畫布尺寸必須大於零。");
  }
  const scale = shortEdge / Math.min(logicalWidth, logicalHeight);
  return {
    width: Math.round(logicalWidth * scale),
    height: Math.round(logicalHeight * scale),
    scale,
  };
}

function createHighResolutionCanvas(logicalWidth, logicalHeight) {
  const pixels = reportPixelDimensions(logicalWidth, logicalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = pixels.width;
  canvas.height = pixels.height;
  const context = canvas.getContext("2d", { alpha: false });
  if (context) {
    context.scale(pixels.scale, pixels.scale);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
  }
  return { canvas, context };
}

async function renderMealPage({ dateLabel, meal, entries, pageIndex, pageCount, chunkStart }) {
  const { canvas, context } = createHighResolutionCanvas(REPORT_WIDTH, REPORT_HEIGHT);
  if (!context) throw new Error("瀏覽器無法建立手機報告畫布。");
  context.fillStyle = "#ebe9e2";
  context.fillRect(0, 0, REPORT_WIDTH, REPORT_HEIGHT);
  fillRoundedRect(context, 36, 32, 1008, 1856, 42, "#fffefa");

  context.textAlign = "left";
  context.fillStyle = "#718079";
  context.font = `750 23px ${FONT_FAMILY}`;
  context.fillText(dateLabel, 74, 92);
  context.fillStyle = "#18342c";
  context.font = `850 48px ${FONT_FAMILY}`;
  context.fillText(`${meal.label}營養報告`, 74, 151);
  context.textAlign = "right";
  context.fillStyle = "#718079";
  context.font = `750 22px ${FONT_FAMILY}`;
  context.fillText(pageCount > 1 ? `${pageIndex + 1} / ${pageCount}` : `${entries.length} 張照片`, 1006, 130);

  const mosaic = { x: 74, y: 190, width: 932, height: 720 };
  const decodedPhotos = await Promise.all(entries.map(async entry => {
    try {
      return await decodePhoto(entry.sourcePhoto?.blob);
    } catch {
      return null;
    }
  }));
  const aspectRatios = decodedPhotos.map((image, index) => image
    ? reportCropAspectRatio(
      image.width || image.naturalWidth,
      image.height || image.naturalHeight,
      entries[index].resultPhoto?.analysis?.report_crop_box,
    )
    : 1);
  const layout = containedPhotoLayout(aspectRatios, mosaic.width, mosaic.height, 16);
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const rect = { ...layout[index], x: layout[index].x + mosaic.x, y: layout[index].y + mosaic.y };
      if (decodedPhotos[index]) drawPhotoContained(
        context,
        decodedPhotos[index],
        rect,
        entries[index].resultPhoto?.analysis?.report_crop_box,
      );
      else drawPhotoPlaceholder(context, rect);
      drawPhotoBadge(context, rect, chunkStart + index + 1);
    }
    if (entries.length === 3) {
      const spare = equalPhotoLayout(4, mosaic.width, mosaic.height, 16)[3];
      const itemCount = entries.reduce((sum, entry) => sum + (entry.resultPhoto?.analysis?.items?.length || 0), 0);
      drawMosaicSummary(context, { ...spare, x: spare.x + mosaic.x, y: spare.y + mosaic.y }, meal, itemCount);
    }
  } finally {
    decodedPhotos.forEach(image => { if (image && typeof image.close === "function") image.close(); });
  }

  context.textAlign = "left";
  context.fillStyle = "#18342c";
  context.font = `850 30px ${FONT_FAMILY}`;
  context.fillText("照片中的營養品項", 74, 974);
  context.fillStyle = "#89958f";
  context.font = `650 19px ${FONT_FAMILY}`;
  context.fillText("編號對應上方照片", 74, 1006);

  const allItems = entries.flatMap((entry, photoIndex) => (entry.resultPhoto?.analysis?.items || []).map(item => ({
    ...item,
    photoNumber: chunkStart + photoIndex + 1,
  })));
  const maxVisible = 8;
  const visibleItems = allItems.length > maxVisible ? allItems.slice(0, maxVisible - 1) : allItems.slice(0, maxVisible);
  const cards = allItems.length > maxVisible ? [...visibleItems, { overflow: allItems.length - visibleItems.length }] : visibleItems;
  const cardWidth = 452;
  const cardHeight = 92;
  cards.forEach((item, index) => {
    const x = 74 + (index % 2) * (cardWidth + 28);
    const y = 1032 + Math.floor(index / 2) * (cardHeight + 14);
    if (item.overflow) drawOverflowCard(context, item.overflow, x, y, cardWidth, cardHeight);
    else drawItemCard(context, item, index, x, y, cardWidth, cardHeight);
  });
  if (!cards.length) {
    context.fillStyle = "#718079";
    context.font = `650 23px ${FONT_FAMILY}`;
    context.fillText("這一頁沒有可顯示的品項。", 74, 1090);
  }

  drawMealTotals(context, meal.totals || {});
  context.fillStyle = "#89958f";
  context.font = `650 18px ${FONT_FAMILY}`;
  context.textAlign = "center";
  context.fillText("營養數值依照片與備註估算 · Calories Guard", REPORT_WIDTH / 2, 1851);
  return blobFromCanvas(canvas);
}

function safeFilePart(value) {
  return String(value || "餐次").replace(/[\\/:*?"<>|]/gu, "_").trim() || "餐次";
}

export function dailyPhotoLayout(count, width, gap = 16) {
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error("每餐照片數量必須介於 1 到 10 張。");
  const columns = count === 1 ? 1 : count === 2 ? 2 : count === 4 ? 2 : 3;
  const tileHeight = count === 1 ? 420 : count === 2 ? 360 : 320;
  const rows = Math.ceil(count / columns);
  const tileWidth = (width - gap * (columns - 1)) / columns;
  const rects = [];
  for (let row = 0; row < rows; row += 1) {
    const rowCount = Math.min(columns, count - row * columns);
    const rowWidth = rowCount * tileWidth + (rowCount - 1) * gap;
    const startX = (width - rowWidth) / 2;
    for (let column = 0; column < rowCount; column += 1) {
      rects.push({
        x: startX + column * (tileWidth + gap),
        y: row * (tileHeight + gap),
        width: tileWidth,
        height: tileHeight,
      });
    }
  }
  return { rects, height: rows * tileHeight + (rows - 1) * gap };
}

function rowPartitions(total, maximum = 3, prefix = []) {
  if (total === 0) return [prefix];
  const layouts = [];
  for (let size = 1; size <= Math.min(maximum, total); size += 1) {
    layouts.push(...rowPartitions(total - size, maximum, [...prefix, size]));
  }
  return layouts;
}

export function photoAreaWeight(itemCount) {
  const count = Number.isInteger(itemCount) && itemCount > 0 ? itemCount : 1;
  return Math.min(3.25, 1 + (count - 1) * 0.45);
}

function photoOrderCandidates(indices, ratios, weights) {
  if (indices.length <= 6) return permutations(indices);
  const orders = [];
  const seen = new Set();
  const add = order => {
    const key = order.join(",");
    if (!seen.has(key)) {
      seen.add(key);
      orders.push(order);
    }
  };
  for (let offset = 0; offset < indices.length; offset += 1) {
    add([...indices.slice(offset), ...indices.slice(0, offset)]);
  }
  const metrics = [
    index => ratios[index],
    index => weights[index],
    index => Math.sqrt(ratios[index] * weights[index]),
    index => Math.sqrt(weights[index] / ratios[index]),
  ];
  for (const metric of metrics) {
    add([...indices].sort((first, second) => metric(first) - metric(second) || first - second));
    add([...indices].sort((first, second) => metric(second) - metric(first) || first - second));
  }
  return orders;
}

export function optimizedDailyPhotoLayout(aspectRatios, width, gap = 16, options = {}) {
  if (!Array.isArray(aspectRatios) || aspectRatios.length < 1 || aspectRatios.length > 10) {
    throw new Error("每餐照片數量必須介於 1 到 10 張。");
  }
  const ratios = aspectRatios.map(value => Number.isFinite(value) && value > 0 ? value : 1);
  const weights = ratios.map((_, index) => photoAreaWeight(options.itemCounts?.[index]));
  const targetScale = options.targetScale ?? 460;
  const maximumRowHeight = options.maximumRowHeight ?? 560;
  const minimumShortEdge = options.minimumShortEdge ?? 240;
  const indices = ratios.map((_, index) => index);
  let best = null;

  for (const order of photoOrderCandidates(indices, ratios, weights)) {
    for (const partition of rowPartitions(ratios.length)) {
      const rows = [];
      let cursor = 0;
      let scale = targetScale;
      for (const size of partition) {
        const row = order.slice(cursor, cursor + size);
        cursor += size;
        const availableWidth = width - gap * (size - 1);
        const widthFactor = row.reduce((sum, index) => sum + Math.sqrt(ratios[index] * weights[index]), 0);
        scale = Math.min(scale, availableWidth / widthFactor);
        for (const index of row) {
          scale = Math.min(scale, maximumRowHeight / Math.sqrt(weights[index] / ratios[index]));
        }
        rows.push(row);
      }

      const rects = Array(ratios.length);
      let y = 0;
      let unusedArea = 0;
      let minimumDisplayedEdge = Infinity;
      rows.forEach((row, rowIndex) => {
        const dimensions = row.map(index => ({
          index,
          width: scale * Math.sqrt(ratios[index] * weights[index]),
          height: scale * Math.sqrt(weights[index] / ratios[index]),
        }));
        const rowHeight = Math.max(...dimensions.map(item => item.height));
        const rowWidth = dimensions.reduce((sum, item) => sum + item.width, 0) + gap * (dimensions.length - 1);
        let x = (width - rowWidth) / 2;
        for (const item of dimensions) {
          rects[item.index] = {
            x,
            y: y + (rowHeight - item.height) / 2,
            width: item.width,
            height: item.height,
          };
          minimumDisplayedEdge = Math.min(minimumDisplayedEdge, item.width, item.height);
          x += item.width + gap;
        }
        unusedArea += Math.max(0, width - rowWidth) * rowHeight;
        y += rowHeight;
        if (rowIndex < rows.length - 1) y += gap;
      });

      const shortfall = Math.max(0, minimumShortEdge - minimumDisplayedEdge);
      const score = y + unusedArea / width * 0.35 + shortfall * shortfall * 2;
      if (!best || score < best.score - 0.001 || (Math.abs(score - best.score) < 0.001 && scale > best.scale)) {
        best = { rects, height: y, rows: rows.length, scale, minimumDisplayedEdge, score, weights };
      }
    }
  }
  return best;
}

function dailyMealHeight(photoLayoutOrCount) {
  const photoHeight = typeof photoLayoutOrCount === "number"
    ? dailyPhotoLayout(photoLayoutOrCount, 912, 16).height
    : photoLayoutOrCount.height;
  return photoHeight + 254;
}

export function dailyReportLayout(photoCounts, options = {}) {
  const headerHeight = options.headerHeight ?? 488;
  const mealGap = options.mealGap ?? 18;
  const footerGap = options.footerGap ?? 42;
  const footerHeight = options.footerHeight ?? 76;
  if (!Array.isArray(photoCounts) || photoCounts.length < 1) {
    throw new Error("全天報告至少需要一個餐次。");
  }
  const mealRects = [];
  let y = headerHeight;
  photoCounts.forEach((photoLayoutOrCount, index) => {
    const height = dailyMealHeight(photoLayoutOrCount);
    mealRects.push({ y, height, bottom: y + height });
    y += height;
    if (index < photoCounts.length - 1) y += mealGap;
  });
  const footerTop = y + footerGap;
  return { mealRects, footerTop, height: footerTop + footerHeight };
}

function horizontalOverlap(firstX, firstWidth, secondX, secondWidth, gap) {
  return firstX < secondX + secondWidth + gap && firstX + firstWidth + gap > secondX;
}

function skylineY(placements, variant, x, gap) {
  let y = 0;
  for (const placement of placements) {
    if (horizontalOverlap(x, variant.width, placement.x, placement.width, gap)) {
      y = Math.max(y, placement.y + placement.height + gap);
    }
  }
  return y;
}

function skylineXPositions(placements, variant, canvasWidth, gap) {
  const cardWidth = variant.width;
  const positions = new Set([0, canvasWidth - cardWidth, (canvasWidth - cardWidth) / 2]);
  for (const placement of placements) {
    positions.add(placement.x);
    positions.add(placement.x + placement.width + gap);
    positions.add(placement.x - gap - cardWidth);
  }
  return [...positions]
    .filter(value => value >= -0.001 && value + cardWidth <= canvasWidth + 0.001)
    .map(value => Math.max(0, Math.min(canvasWidth - cardWidth, value)))
    .sort((first, second) => first - second);
}

function skylineStateScore(state, canvasWidth, emptyAreaWeight = 0.55) {
  const usedArea = state.placements.reduce((sum, placement) => sum + placement.width * placement.height, 0);
  const unusedArea = Math.max(0, canvasWidth * state.height - usedArea);
  return state.height + unusedArea / canvasWidth * emptyAreaWeight + state.penalty;
}

export function skylineMealLayout(variantGroups, canvasWidth = 960, gap = 18, options = {}) {
  if (!Array.isArray(variantGroups) || !variantGroups.length) throw new Error("動態報告至少需要一個餐次。");
  const beamWidth = options.beamWidth ?? 480;
  const emptyAreaWeight = options.emptyAreaWeight ?? 0.55;
  let states = [{ placements: [], height: 0, penalty: 0, lastY: 0, lastX: -Infinity }];

  for (let mealIndex = 0; mealIndex < variantGroups.length; mealIndex += 1) {
    const variants = variantGroups[mealIndex];
    if (!Array.isArray(variants) || !variants.length) throw new Error("每個餐次至少需要一種可用版型。");
    const nextStates = [];
    for (const state of states) {
      for (const variant of variants) {
        if (!(variant.width > 0) || !(variant.height > 0) || variant.width > canvasWidth + 0.001) continue;
        for (const x of skylineXPositions(state.placements, variant, canvasWidth, gap)) {
          const y = skylineY(state.placements, variant, x, gap);
          if (y < state.lastY - 0.001) continue;
          if (Math.abs(y - state.lastY) < 0.001 && x <= state.lastX + 0.001) continue;
          const placement = { ...variant, mealIndex, x, y };
          const placements = [...state.placements, placement];
          nextStates.push({
            placements,
            height: Math.max(state.height, y + variant.height),
            penalty: state.penalty + (variant.penalty || 0),
            lastY: y,
            lastX: x,
          });
        }
      }
    }
    if (!nextStates.length) throw new Error("餐次版型無法放入全天報告。");
    nextStates.sort((first, second) => skylineStateScore(first, canvasWidth, emptyAreaWeight)
      - skylineStateScore(second, canvasWidth, emptyAreaWeight));
    const unique = new Map();
    for (const state of nextStates) {
      const key = state.placements.map(item => [item.x, item.y, item.width, item.height]
        .map(value => Math.round(value * 10) / 10).join(",")).join(";");
      if (!unique.has(key)) unique.set(key, state);
      if (unique.size >= beamWidth) break;
    }
    states = [...unique.values()];
  }
  states.sort((first, second) => skylineStateScore(first, canvasWidth, emptyAreaWeight)
    - skylineStateScore(second, canvasWidth, emptyAreaWeight));
  return states[0];
}

export function flexibleMealLayout(variantGroups, mealIds, canvasWidth = 960, gap = 18, options = {}) {
  if (!Array.isArray(variantGroups) || !Array.isArray(mealIds) || variantGroups.length !== mealIds.length) {
    throw new Error("餐次版型與餐次順序資料不一致。");
  }
  const coreRank = new Map([["breakfast", 0], ["lunch", 1], ["dinner", 2]]);
  const indices = variantGroups.map((_, index) => index);
  const orders = permutations(indices).filter(order => {
    const core = order.filter(index => coreRank.has(mealIds[index]));
    return core.every((index, position) => position === 0
      || coreRank.get(mealIds[core[position - 1]]) < coreRank.get(mealIds[index]));
  });
  const emptyAreaWeight = options.emptyAreaWeight ?? 0.55;
  let best = null;
  for (const order of orders) {
    const candidate = skylineMealLayout(order.map(index => variantGroups[index]), canvasWidth, gap, options);
    const placements = candidate.placements.map(placement => ({
      ...placement,
      mealIndex: order[placement.mealIndex],
    }));
    const state = { ...candidate, placements, order };
    const score = skylineStateScore(state, canvasWidth, emptyAreaWeight);
    if (!best || score < best.score - 0.001) best = { ...state, score };
  }
  if (!best) throw new Error("找不到符合早、午、晚餐順序的報告版面。");
  return best;
}

function drawDailyTotals(context, totals, photoCount, mealCount, nutritionTargets = {}) {
  const x = 60;
  const y = 184;
  const width = 960;
  const height = 312;
  fillRoundedRect(context, x, y, width, height, 30, "#143f33");
  context.textAlign = "left";
  context.fillStyle = "#b9d8ca";
  context.font = `750 24px ${FONT_FAMILY}`;
  context.fillText(`${mealCount} 個餐次 · ${photoCount} 張照片`, x + 34, y + 43);
  context.fillStyle = "#9fc6b5";
  context.font = `700 23px ${FONT_FAMILY}`;
  context.fillText("今日熱量", x + 34, y + 81);
  context.fillStyle = "#ffffff";
  context.font = `850 68px ${FONT_FAMILY}`;
  context.fillText(number(totals.calories_kcal), x + 34, y + 148);
  context.fillStyle = "#b9d8ca";
  context.font = `750 22px ${FONT_FAMILY}`;
  context.fillText("kcal", x + 36, y + 177);
  const calorieStatus = reportTargetStatus(totals.calories_kcal, nutritionTargets.calories_kcal, "kcal");
  if (calorieStatus) {
    context.fillStyle = "#b9d8ca";
    context.font = `650 17px ${FONT_FAMILY}`;
    context.fillText(calorieStatus, x + 34, y + 207);
  }
  context.fillStyle = "rgba(185,216,202,.28)";
  context.fillRect(x + 338, y + 28, 2, height - 56);
  const cells = [
    ["蛋白質", "protein_g", "g"], ["碳水化合物", "carbs_g", "g"], ["脂肪", "fat_g", "g"],
    ["膳食纖維", "fiber_g", "g"], ["糖", "sugar_g", "g"], ["鈉", "sodium_mg", "mg"],
  ];
  const cellWidth = (width - 382) / 2;
  cells.forEach(([label, key, unit], index) => {
    const column = Math.floor(index / 3);
    const row = index % 3;
    const cellX = x + 370 + column * cellWidth;
    const cellY = y + 46 + row * 88;
    context.fillStyle = "#9fc6b5";
    context.font = `700 21px ${FONT_FAMILY}`;
    context.fillText(label, cellX, cellY);
    context.fillStyle = "#ffffff";
    context.font = `800 30px ${FONT_FAMILY}`;
    context.fillText(`${number(totals[key])} ${unit}`, cellX, cellY + 32);
    const status = reportTargetStatus(totals[key], nutritionTargets[key], unit);
    if (status) {
      context.fillStyle = "#b9d8ca";
      context.font = `650 17px ${FONT_FAMILY}`;
      context.fillText(status, cellX, cellY + 57);
    }
  });
}

function wrapCompleteText(context, text, width) {
  const characters = Array.from(String(text || ""));
  if (!characters.length) return [""];
  const lines = [];
  let current = "";
  for (const character of characters) {
    const candidate = current + character;
    if (current && context.measureText(candidate).width > width) {
      lines.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

export function compactItemLines(context, items, width) {
  context.font = `650 29px ${FONT_FAMILY}`;
  const tokens = items.map(item => item.name || "未命名品項");
  const lines = [];
  let current = "";
  for (const token of tokens) {
    const candidate = current ? `${current}　·　${token}` : token;
    if (context.measureText(candidate).width <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    const wrappedToken = wrapCompleteText(context, token, width);
    lines.push(...wrappedToken.slice(0, -1));
    current = wrappedToken.at(-1) || "";
  }
  if (current) lines.push(current);
  if (!lines.length) lines.push("沒有可顯示的品項");
  return lines;
}

const NOTE_PORTION_AMOUNT = String.raw`(?:[一二兩三四五六七八九十百千零〇\d]+\s*分之\s*[一二兩三四五六七八九十百千零〇\d]+|\d+\s*\/\s*\d+|[¼½¾⅓⅔⅛⅜⅝⅞]|\d+(?:\.\d+)?|[一二兩三四五六七八九十百千零〇半]+)`;
const NOTE_PORTION_UNIT = String.raw`(?:g|kg|ml|l|克|公克|公斤|毫升|公升|碗|杯|份|條|根|顆|粒|片|塊|匙|茶匙|湯匙|罐|瓶|包|盒|個|球|串)`;
const NOTE_PORTION = `${NOTE_PORTION_AMOUNT}\\s*${NOTE_PORTION_UNIT}`;

export function noteHasPortionInformation(note) {
  return new RegExp(NOTE_PORTION, "iu").test(String(note || ""));
}

export function portionFromNoteForItem(itemName, note) {
  const name = String(itemName || "").trim();
  if (!name) return "";
  const clauses = String(note || "").split(/[，,、；;。\n]/u);
  for (const clause of clauses) {
    const nameIndex = clause.indexOf(name);
    if (nameIndex < 0) continue;
    const beforeName = clause.slice(0, nameIndex);
    const afterName = clause.slice(nameIndex + name.length);
    const afterMatch = afterName.match(new RegExp(`^[\\s:：為約大概共吃了]*(?<portion>${NOTE_PORTION})`, "iu"));
    if (afterMatch?.groups?.portion) return afterMatch.groups.portion.replace(/\s+/gu, " ").trim();
    const beforeMatch = beforeName.match(new RegExp(`(?<portion>${NOTE_PORTION})\\s*(?:的)?\\s*$`, "iu"));
    if (beforeMatch?.groups?.portion) return beforeMatch.groups.portion.replace(/\s+/gu, " ").trim();
  }
  return "";
}

export function reportItemsWithPortions(items, note = "") {
  const source = Array.isArray(items) ? items : [];
  return source.map(item => {
    const name = item?.name || "未命名品項";
    const structuredPortion = typeof item?.portion_description === "string" ? item.portion_description.trim() : "";
    const portion = structuredPortion || portionFromNoteForItem(name, note);
    return { ...item, name: portion ? `${name}（${portion}）` : name };
  });
}

function drawCompactItems(context, lines, x, y, width) {
  context.textAlign = "left";
  context.fillStyle = "#18342c";
  context.font = `800 33px ${FONT_FAMILY}`;
  context.fillText("品項", x, y);
  context.fillStyle = "#5f6e68";
  context.font = `650 29px ${FONT_FAMILY}`;
  lines.forEach((line, index) => context.fillText(line, x, y + 40 + index * 39));
}

function releaseDecodedPhoto(image) {
  if (!image) return;
  if (typeof image.close === "function") image.close();
  else if ("src" in image) image.src = "";
}

async function drawDailyMeal(context, mealData, placement, originX, originY) {
  const { meal, entries } = mealData;
  const { photoLayout: mosaic, itemLines, width, height } = placement;
  const x = originX + placement.x;
  const y = originY + placement.y;
  fillRoundedRect(context, x, y, width, height, 30, "#fffefa");
  context.textAlign = "left";
  context.fillStyle = "#18342c";
  context.font = `850 47px ${FONT_FAMILY}`;
  context.fillText(meal.label, x + 28, y + 59);
  context.fillStyle = "#718079";
  context.font = `700 25px ${FONT_FAMILY}`;
  context.fillText(entries.length ? `${entries.length} 張照片` : "文字餐點紀錄", x + 28, y + 96);

  const decodedPhotos = await Promise.all(entries.map(async entry => {
    try { return await decodePhoto(entry.sourcePhoto?.blob); }
    catch { return null; }
  }));
  try {
    for (let index = 0; index < entries.length; index += 1) {
      const layout = mosaic.rects[index];
      const rect = { ...layout, x: layout.x + x + 24, y: layout.y + y + 118 };
      if (decodedPhotos[index]) drawPhotoContained(
        context,
        decodedPhotos[index],
        rect,
        entries[index].resultPhoto?.analysis?.report_crop_box,
      );
      else drawPhotoPlaceholder(context, rect);
    }
  } finally {
    decodedPhotos.forEach(releaseDecodedPhoto);
  }

  const itemsY = y + (entries.length ? 118 + mosaic.height + 47 : 140);
  drawCompactItems(
    context,
    itemLines,
    x + 28,
    itemsY,
    width - 56,
  );
  return height;
}

async function prepareDailyMeal(mealData) {
  const decodedPhotos = await Promise.all(mealData.entries.map(async entry => {
    try { return await decodePhoto(entry.sourcePhoto?.blob); }
    catch { return null; }
  }));
  const cropBoxes = mealData.entries.map(entry => entry.resultPhoto?.analysis?.report_crop_box);
  const aspectRatios = decodedPhotos.map((image, index) => {
    if (!image) return 1;
    const imageWidth = image.width || image.naturalWidth;
    const imageHeight = image.height || image.naturalHeight;
    return reportCropAspectRatio(imageWidth, imageHeight, cropBoxes[index]);
  });
  decodedPhotos.forEach(releaseDecodedPhoto);
  const analysisItems = Array.isArray(mealData.meal?.items) ? mealData.meal.items : [];
  const items = reportItemsWithPortions(analysisItems, mealData.meal?.note);
  const foodPhotoCount = mealData.entries.filter(entry => {
    const role = entry.resultPhoto?.role || entry.resultPhoto?.analysis?.photo_role;
    return role === "food" || role === "mixed";
  }).length;
  const itemCounts = mealData.entries.map(entry => {
    const explicit = entry.resultPhoto?.visible_item_count ?? entry.resultPhoto?.analysis?.visible_item_count;
    if (Number.isInteger(explicit) && explicit > 0) return explicit;
    const role = entry.resultPhoto?.role || entry.resultPhoto?.analysis?.photo_role;
    if (role === "product_front" || role === "nutrition_label") return 1;
    if ((role === "food" || role === "mixed") && foodPhotoCount > 0) {
      return Math.max(1, Math.ceil(analysisItems.length / foodPhotoCount));
    }
    return mealData.entries.length === 1 ? Math.max(1, analysisItems.length) : 1;
  });
  return { ...mealData, aspectRatios, cropBoxes, items, itemCounts };
}

function buildMealVariants(context, mealData) {
  const gridColumnWidth = 80;
  const columnCounts = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const largestItemCount = Math.max(1, ...(mealData.itemCounts || [1]));
  const minimumPhotoEdge = largestItemCount === 1 ? 120 : 135;
  const targetScale = Math.min(420, 200 + (largestItemCount - 1) * 50);
  const acceptableScaleRatio = largestItemCount === 1 ? 0.58 : 0.32;
  const createCandidate = columnCount => {
    const width = columnCount * gridColumnWidth;
    const photoLayout = mealData.aspectRatios.length
      ? optimizedDailyPhotoLayout(mealData.aspectRatios, width - 48, 16, {
        itemCounts: mealData.itemCounts,
        minimumShortEdge: minimumPhotoEdge,
      })
      : { rects: [], height: 0, minimumDisplayedEdge: Infinity };
    const itemLines = compactItemLines(context, mealData.items, width - 56);
    const contentHeight = photoLayout.height + (mealData.aspectRatios.length ? 232 : 206)
      + Math.max(0, itemLines.length - 1) * 39;
    const height = Math.ceil(contentHeight);
    const shortfall = Math.max(0, targetScale - (photoLayout.scale || targetScale));
    return {
      width,
      height,
      photoLayout,
      itemLines,
      penalty: shortfall * shortfall * (largestItemCount === 1 ? 0.007 : 0.0015),
    };
  };
  const candidates = columnCounts.map(createCandidate);
  const readable = candidates.filter(candidate => candidate.photoLayout.minimumDisplayedEdge >= minimumPhotoEdge
    && (candidate.photoLayout.scale || targetScale) >= targetScale * acceptableScaleRatio);
  return readable.length ? readable : candidates
    .sort((first, second) => second.photoLayout.minimumDisplayedEdge - first.photoLayout.minimumDisplayedEdge)
    .slice(0, 3);
}

async function renderDailyReport({ dateLabel, totals, nutritionTargets, meals }) {
  const preparedMeals = [];
  for (const meal of meals) preparedMeals.push(await prepareDailyMeal(meal));
  const measurementCanvas = document.createElement("canvas");
  const measurementContext = measurementCanvas.getContext("2d");
  if (!measurementContext) throw new Error("瀏覽器無法計算全天報告版型。");
  const variantGroups = preparedMeals.map(meal => buildMealVariants(measurementContext, meal));
  const layout = flexibleMealLayout(
    variantGroups,
    preparedMeals.map(meal => meal.meal.id),
    960,
    18,
    { emptyAreaWeight: 0.55 },
  );
  const headerHeight = 530;
  const footerGap = 42;
  const footerHeight = 76;
  const footerTop = headerHeight + layout.height + footerGap;
  const reportHeight = footerTop + footerHeight;
  const { canvas, context } = createHighResolutionCanvas(REPORT_WIDTH, reportHeight);
  if (!context) throw new Error("瀏覽器無法建立全天報告畫布。");
  context.fillStyle = "#ebe9e2";
  context.fillRect(0, 0, REPORT_WIDTH, reportHeight);
  context.textAlign = "left";
  context.fillStyle = "#718079";
  context.font = `750 34px ${FONT_FAMILY}`;
  context.fillText(dateLabel, 60, 72);
  context.fillStyle = "#18342c";
  context.font = `850 74px ${FONT_FAMILY}`;
  context.fillText("今日營養報告", 60, 150);
  const photoCount = meals.reduce((sum, meal) => sum + meal.entries.length, 0);
  drawDailyTotals(context, totals || {}, photoCount, meals.length, nutritionTargets || {});
  for (const placement of layout.placements) {
    await drawDailyMeal(context, preparedMeals[placement.mealIndex], placement, 60, headerHeight);
  }
  context.fillStyle = "#89958f";
  context.font = `650 28px ${FONT_FAMILY}`;
  context.textAlign = "center";
  context.fillText("營養數值依照片與備註估算 · Calories Guard", REPORT_WIDTH / 2, footerTop + 48);
  return blobFromCanvas(canvas);
}

export function orderReportEntries(entries) {
  const rolePriority = { product_front: 0, food: 1, mixed: 1, other: 2, nutrition_label: 3 };
  const prepared = entries.map((entry, originalIndex) => ({ ...entry, originalIndex }));
  const identityOf = entry => String(
    entry.resultPhoto?.subject_identity || entry.resultPhoto?.analysis?.subject_identity || "",
  ).trim().toLocaleLowerCase("zh-TW")
    .replace(/營養(?:成分)?標示|成分標示|商品照|包裝|正面|背面/gu, "")
    .replace(/[\s\p{P}\p{S}]/gu, "");
  const confirmedIdentity = identity => identity && !["無法確認", "未知", "unknown", "uncertain"].includes(identity);
  const productIdentities = prepared
    .filter(entry => (entry.resultPhoto?.role || entry.resultPhoto?.analysis?.photo_role) === "product_front")
    .map(identityOf)
    .filter(confirmedIdentity);
  const matchesProductIdentity = identity => productIdentities.some(productIdentity => identity === productIdentity
    || (Math.min(identity.length, productIdentity.length) >= 4
      && (identity.includes(productIdentity) || productIdentity.includes(identity))));
  return prepared
    .filter(entry => {
      const role = entry.resultPhoto?.role || entry.resultPhoto?.analysis?.photo_role;
      const identity = identityOf(entry);
      const includeInReport = entry.resultPhoto?.include_in_report ?? entry.resultPhoto?.analysis?.include_in_report;
      if (includeInReport === false) return false;
      return role !== "nutrition_label" || !confirmedIdentity(identity) || !matchesProductIdentity(identity);
    })
    .sort((first, second) => (rolePriority[first.resultPhoto?.role || first.resultPhoto?.analysis?.photo_role] ?? 2)
      - (rolePriority[second.resultPhoto?.role || second.resultPhoto?.analysis?.photo_role] ?? 2)
      || first.originalIndex - second.originalIndex);
}

export async function buildMealReportImages({ date, dateLabel, totals, nutritionTargets, meals, resultPhotos, sourcePhotos }) {
  if (!Array.isArray(meals) || !meals.length) throw new Error("請先計算營養，才能產生全天手機報告。");
  const dailyMeals = meals.flatMap(meal => {
    const reports = (resultPhotos || []).filter(photo => photo.mealType === meal.id);
    const sources = (sourcePhotos || []).filter(photo => photo.mealType === meal.id);
    const entries = orderReportEntries(reports.map((resultPhoto, index) => ({ resultPhoto, sourcePhoto: sources[index] })));
    return entries.length || meal.items?.length || meal.note ? [{ meal, entries }] : [];
  });
  if (!dailyMeals.length) throw new Error("目前沒有可加入全天報告的餐點資料。");
  const blob = await renderDailyReport({ dateLabel, totals, nutritionTargets, meals: dailyMeals });
  return [{ blob, fileName: `今日營養報告-${safeFilePart(date)}.jpg`, mimeType: "image/jpeg" }];
}
