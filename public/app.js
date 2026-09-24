import { Capacitor } from "@capacitor/core";
import { Camera, CameraDirection, CameraResultType, CameraSource } from "@capacitor/camera";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { GallerySaver } from "@calories-guard/gallery-saver";
import nutritionPrompt from "../prompt.txt";
import { analyzeImagesOnDevice, mergeAnalysisResults } from "./mobile-gemini.js";
import { deleteDeviceHistoryRecord, listDeviceHistoryDates } from "./device-history.js";
import { buildMealReportImages } from "./report-export.js";
import {
  createStaticBackup,
  deleteStaticHistoryRecord,
  deleteStaticReport,
  importStaticBackup,
  isStaticHostedWeb,
  listStaticHistoryDates,
  listStaticHistoryRecords,
  readStaticHistoryRecord,
  readStaticReport,
  saveStaticHistoryRecord,
  saveStaticReport,
} from "./static-web-storage.js";

"use strict";

const MEALS = [
  { id: "breakfast", label: "早餐", hint: "開啟一天的第一餐", icon: "☀" },
  { id: "lunch", label: "午餐", hint: "白天的主要餐點", icon: "●" },
  { id: "afternoon_tea", label: "下午茶", hint: "點心、飲料與水果", icon: "◒" },
  { id: "dinner", label: "晚餐", hint: "一天結束前的正餐", icon: "◐" },
  { id: "late_night", label: "宵夜", hint: "睡前吃下的食物", icon: "☾" },
];
const MEAL_MAP = new Map(MEALS.map(meal => [meal.id, meal]));
const MAX_PHOTOS_PER_MEAL = 10;
const MAX_TOTAL_PHOTOS = 30;
const MAX_IMAGE_BYTES = 14_000_000;
const MAX_TOTAL_IMAGE_BYTES = 35_000_000;
const MAX_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 0.84;
const NOTE_MAX_LENGTH = 1000;
const REQUEST_TIMEOUT_MS = 600_000;
const TARGET_STORAGE_KEY = "nutrition-daily-targets-v1";
const CONNECTION_STORAGE_KEY = "nutrition-gemini-connection-v1";
const GALLERY_EXPORT_IDS_KEY = "nutrition-gallery-export-ids-v1";
const GENERATED_REPORT_CACHE = "nutrition-generated-reports-v1";
const GENERATED_REPORT_DIRECTORY = "generated-reports";
const SERVER_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);
const STATIC_HOSTED_WEB = !Capacitor.isNativePlatform() && isStaticHostedWeb();

const NUTRIENTS = [
  { key: "calories_kcal", label: "熱量", unit: "kcal", tone: "calories" },
  { key: "protein_g", label: "蛋白質", unit: "g", tone: "protein" },
  { key: "fat_g", label: "脂肪", unit: "g", tone: "fat" },
  { key: "carbs_g", label: "碳水化合物", unit: "g", tone: "carbs" },
  { key: "fiber_g", label: "膳食纖維", unit: "g", tone: "fiber" },
  { key: "sugar_g", label: "糖", unit: "g", tone: "sugar" },
  { key: "sodium_mg", label: "鈉", unit: "mg", tone: "sodium" },
];

function loadNutritionTargets() {
  try {
    const stored = JSON.parse(localStorage.getItem(TARGET_STORAGE_KEY) || "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(NUTRIENTS.flatMap(nutrient => {
      const value = stored[nutrient.key];
      return typeof value === "number" && Number.isFinite(value) && value > 0 ? [[nutrient.key, value]] : [];
    }));
  } catch {
    return {};
  }
}

function loadConnectionSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(CONNECTION_STORAGE_KEY) || "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return { apiKey: "", splitItems: true };
    return {
      apiKey: typeof stored.apiKey === "string" ? stored.apiKey.trim() : "",
      splitItems: stored.splitItems !== false,
    };
  } catch {
    return { apiKey: "", splitItems: true };
  }
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromKey(key) {
  const [year, month, day] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function formatRecordDate(key) {
  return new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(dateFromKey(key));
}

function emptyMealNotes() {
  return Object.fromEntries(MEALS.map(meal => [meal.id, ""]));
}

function hasMealContent() {
  return state.photos.length > 0 || MEALS.some(meal => state.mealNotes[meal.id]?.trim());
}

const state = {
  photos: [],
  mealNotes: emptyMealNotes(),
  mealAnalysisCache: {},
  busy: false,
  result: null,
  activeMealId: "breakfast",
  activeDate: localDateKey(),
  historyDates: new Set(),
  calendarCursor: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  nutritionTargets: loadNutritionTargets(),
  connection: loadConnectionSettings(),
  analysisController: null,
  expandedPhotoMeals: new Set(),
};

let historySaveQueue = Promise.resolve();
let activePhotoPreviewUrl = "";
let pendingGeneratedImage = null;
let photoViewerZoom = 1;
let photoViewerGesture = null;

const dom = {
  appShell: document.querySelector(".app-shell"),
  topTotalCalories: document.querySelector("#top-total-calories"),
  topProtein: document.querySelector("#top-protein"),
  topCarbs: document.querySelector("#top-carbs"),
  topFat: document.querySelector("#top-fat"),
  activeDateLabel: document.querySelector("#active-date-label"),
  photoHeading: document.querySelector("#photo-heading"),
  returnTodayButton: document.querySelector("#return-today-button"),
  nutritionMenuButton: document.querySelector("#nutrition-menu-button"),
  nutritionSettingsDialog: document.querySelector("#nutrition-settings-dialog"),
  nutritionSettingsClose: document.querySelector("#nutrition-settings-close"),
  nutritionSettingsForm: document.querySelector("#nutrition-settings-form"),
  nutritionSettingsClear: document.querySelector("#nutrition-settings-clear"),
  geminiApiKey: document.querySelector("#gemini-api-key"),
  splitFoodItems: document.querySelector("#split-food-items"),
  toggleApiKey: document.querySelector("#toggle-api-key"),
  openApiKeyGuide: document.querySelector("#open-api-key-guide"),
  apiKeyGuideDialog: document.querySelector("#api-key-guide-dialog"),
  apiKeyGuideClose: document.querySelector("#api-key-guide-close"),
  connectionStatus: document.querySelector("#connection-status"),
  openHistoryButton: document.querySelector("#open-history-button"),
  historyRecordCount: document.querySelector("#history-record-count"),
  historyDialog: document.querySelector("#history-dialog"),
  historyDialogClose: document.querySelector("#history-dialog-close"),
  calendarPrevious: document.querySelector("#calendar-previous"),
  calendarNext: document.querySelector("#calendar-next"),
  calendarMonthLabel: document.querySelector("#calendar-month-label"),
  calendarGrid: document.querySelector("#calendar-grid"),
  calendarStatus: document.querySelector("#calendar-status"),
  cameraInput: document.querySelector("#camera-input"),
  galleryInput: document.querySelector("#gallery-input"),
  mealSections: document.querySelector("#meal-sections"),
  photoCount: document.querySelector("#photo-count"),
  errorPanel: document.querySelector("#error-panel"),
  errorMessage: document.querySelector("#error-message"),
  progressPanel: document.querySelector("#progress-panel"),
  progressTitle: document.querySelector("#progress-title"),
  progressDetail: document.querySelector("#progress-detail"),
  results: document.querySelector("#results"),
  resultsSummary: document.querySelector("#results-summary"),
  dailyHeadingDate: document.querySelector("#daily-heading-date"),
  totalCalories: document.querySelector("#total-calories"),
  modelLabel: document.querySelector("#model-label"),
  nutrientGrid: document.querySelector("#nutrient-grid"),
  resultPhotoCount: document.querySelector("#result-photo-count"),
  mealResults: document.querySelector("#meal-results"),
  newAnalysisButton: document.querySelector("#new-analysis-button"),
  backToTopButton: document.querySelector("#back-to-top-button"),
  calculateButton: document.querySelector("#calculate-button"),
  exportImageButton: document.querySelector("#export-image-button"),
  exportDialog: document.querySelector("#export-dialog"),
  exportDialogClose: document.querySelector("#export-dialog-close"),
  previewSavedReportButton: document.querySelector("#preview-saved-report-button"),
  saveGalleryButton: document.querySelector("#save-gallery-button"),
  shareExportButton: document.querySelector("#share-export-button"),
  longExportButton: document.querySelector("#long-export-button"),
  actionContext: document.querySelector("#action-context"),
  itemDialog: document.querySelector("#item-dialog"),
  itemDialogMeal: document.querySelector("#item-dialog-meal"),
  itemDialogTitle: document.querySelector("#item-dialog-title"),
  itemDialogContent: document.querySelector("#item-dialog-content"),
  itemDialogClose: document.querySelector("#item-dialog-close"),
  photoViewerDialog: document.querySelector("#photo-viewer-dialog"),
  photoViewerTitle: document.querySelector("#photo-viewer-title"),
  photoViewerStage: document.querySelector(".photo-viewer-stage"),
  photoViewerImage: document.querySelector("#photo-viewer-image"),
  photoViewerClose: document.querySelector("#photo-viewer-close"),
  photoViewerZoomOut: document.querySelector("#photo-viewer-zoom-out"),
  photoViewerZoomReset: document.querySelector("#photo-viewer-zoom-reset"),
  photoViewerZoomIn: document.querySelector("#photo-viewer-zoom-in"),
  photoViewerZoomLabel: document.querySelector("#photo-viewer-zoom-label"),
  exportCompleteDialog: document.querySelector("#export-complete-dialog"),
  exportCompleteCopy: document.querySelector("#export-complete-copy"),
  exportCompleteLater: document.querySelector("#export-complete-later"),
  exportCompleteOpen: document.querySelector("#export-complete-open"),
  staticWebData: document.querySelector("#static-web-data"),
  exportHistoryBackup: document.querySelector("#export-history-backup"),
  importHistoryBackup: document.querySelector("#import-history-backup"),
  historyBackupInput: document.querySelector("#history-backup-input"),
  staticStorageStatus: document.querySelector("#static-storage-status"),
};

function apiFetch(pathname, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.connection.apiKey) headers.set("X-Gemini-Api-Key", state.connection.apiKey);
  return fetch(pathname, { ...options, headers });
}

function makeElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function makeSvg(pathData, viewBox = "0 0 24 24") {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  const path = document.createElementNS(namespace, "path");
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  path.setAttribute("d", pathData);
  svg.append(path);
  return svg;
}

function closePhotoViewer() {
  if (typeof dom.photoViewerDialog.close === "function" && dom.photoViewerDialog.open) dom.photoViewerDialog.close();
  else dom.photoViewerDialog.removeAttribute("open");
  dom.photoViewerImage.removeAttribute("src");
  if (activePhotoPreviewUrl) URL.revokeObjectURL(activePhotoPreviewUrl);
  activePhotoPreviewUrl = "";
  photoViewerGesture = null;
}

function clampPhotoViewerZoom(value) {
  return Math.max(1, Math.min(4, Number.isFinite(value) ? value : 1));
}

function updatePhotoViewerZoom(nextZoom, focusX = null, focusY = null) {
  const stage = dom.photoViewerStage;
  const previousZoom = photoViewerZoom;
  const zoom = clampPhotoViewerZoom(nextZoom);
  const localX = focusX ?? stage.clientWidth / 2;
  const localY = focusY ?? stage.clientHeight / 2;
  const contentX = (stage.scrollLeft + localX) / previousZoom;
  const contentY = (stage.scrollTop + localY) / previousZoom;
  photoViewerZoom = zoom;
  dom.photoViewerImage.style.width = `${zoom * 100}%`;
  dom.photoViewerZoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  dom.photoViewerZoomOut.disabled = zoom <= 1;
  dom.photoViewerZoomIn.disabled = zoom >= 4;
  stage.scrollLeft = Math.max(0, contentX * zoom - localX);
  stage.scrollTop = Math.max(0, contentY * zoom - localY);
}

function resetPhotoViewerZoom() {
  photoViewerZoom = 1;
  dom.photoViewerImage.style.width = "100%";
  dom.photoViewerZoomLabel.textContent = "100%";
  dom.photoViewerZoomOut.disabled = true;
  dom.photoViewerZoomIn.disabled = false;
  dom.photoViewerStage.scrollTo({ left: 0, top: 0, behavior: "auto" });
  photoViewerGesture = null;
}

function touchDistance(first, second) {
  return Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
}

function beginPhotoViewerGesture(event) {
  if (!event.touches.length) return;
  event.preventDefault();
  const stage = dom.photoViewerStage;
  if (event.touches.length === 1) {
    const touch = event.touches[0];
    photoViewerGesture = {
      type: "pan", startX: touch.clientX, startY: touch.clientY,
      scrollLeft: stage.scrollLeft, scrollTop: stage.scrollTop,
    };
    return;
  }
  const [first, second] = event.touches;
  const bounds = stage.getBoundingClientRect();
  const focusX = (first.clientX + second.clientX) / 2 - bounds.left;
  const focusY = (first.clientY + second.clientY) / 2 - bounds.top;
  photoViewerGesture = {
    type: "pinch",
    distance: Math.max(1, touchDistance(first, second)),
    zoom: photoViewerZoom,
    contentX: (stage.scrollLeft + focusX) / photoViewerZoom,
    contentY: (stage.scrollTop + focusY) / photoViewerZoom,
  };
}

function movePhotoViewerGesture(event) {
  if (!photoViewerGesture || !event.touches.length) return;
  event.preventDefault();
  const stage = dom.photoViewerStage;
  if (event.touches.length >= 2 && photoViewerGesture.type === "pinch") {
    const [first, second] = event.touches;
    const bounds = stage.getBoundingClientRect();
    const focusX = (first.clientX + second.clientX) / 2 - bounds.left;
    const focusY = (first.clientY + second.clientY) / 2 - bounds.top;
    const zoom = clampPhotoViewerZoom(photoViewerGesture.zoom
      * touchDistance(first, second) / photoViewerGesture.distance);
    photoViewerZoom = zoom;
    dom.photoViewerImage.style.width = `${zoom * 100}%`;
    dom.photoViewerZoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    dom.photoViewerZoomOut.disabled = zoom <= 1;
    dom.photoViewerZoomIn.disabled = zoom >= 4;
    stage.scrollLeft = Math.max(0, photoViewerGesture.contentX * zoom - focusX);
    stage.scrollTop = Math.max(0, photoViewerGesture.contentY * zoom - focusY);
    return;
  }
  if (event.touches.length === 1 && photoViewerGesture.type === "pan") {
    const touch = event.touches[0];
    stage.scrollLeft = photoViewerGesture.scrollLeft + photoViewerGesture.startX - touch.clientX;
    stage.scrollTop = photoViewerGesture.scrollTop + photoViewerGesture.startY - touch.clientY;
  }
}

function openPhotoViewer(blob, title = "照片預覽") {
  if (!(blob instanceof Blob)) return;
  closePhotoViewer();
  activePhotoPreviewUrl = URL.createObjectURL(blob);
  dom.photoViewerTitle.textContent = title;
  dom.photoViewerImage.alt = `${title}完整圖片`;
  dom.photoViewerImage.src = activePhotoPreviewUrl;
  if (typeof dom.photoViewerDialog.showModal === "function") dom.photoViewerDialog.showModal();
  else dom.photoViewerDialog.setAttribute("open", "");
  requestAnimationFrame(resetPhotoViewerZoom);
}

function closeExportCompleteDialog() {
  if (typeof dom.exportCompleteDialog.close === "function" && dom.exportCompleteDialog.open) dom.exportCompleteDialog.close();
  else dom.exportCompleteDialog.removeAttribute("open");
}

function showExportCompleteDialog(image, message) {
  pendingGeneratedImage = image;
  dom.exportCompleteCopy.textContent = `${message}，是否立即查看完整圖片？`;
  if (typeof dom.exportCompleteDialog.showModal === "function") dom.exportCompleteDialog.showModal();
  else dom.exportCompleteDialog.setAttribute("open", "");
}

function dismissExportCompleteDialog() {
  closeExportCompleteDialog();
  pendingGeneratedImage = null;
}

function openGeneratedImage() {
  const image = pendingGeneratedImage;
  closeExportCompleteDialog();
  pendingGeneratedImage = null;
  if (image) openPhotoViewer(image.blob, image.fileName.replace(/\.(?:png|jpe?g)$/iu, ""));
}

function formatBytes(bytes) {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

function formatNumber(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 1 }).format(value);
}

function nutritionNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function formatNutrient(value, nutrient) {
  return `${formatNumber(nutritionNumber(value))} ${nutrient.unit}`;
}

function getTargetProgress(value, nutrient) {
  const target = state.nutritionTargets[nutrient.key];
  if (typeof target !== "number" || !Number.isFinite(target) || target <= 0
    || typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const percentage = (value / target) * 100;
  return { target, percentage, remaining: target - value };
}

function targetStatusText(value, nutrient) {
  const progress = getTargetProgress(value, nutrient);
  if (!progress) return "";
  const percentage = formatNumber(progress.percentage);
  if (progress.remaining > 0.05) {
    return `達 ${percentage}% · 還可吃 ${formatNumber(progress.remaining)} ${nutrient.unit}`;
  }
  if (progress.remaining < -0.05) {
    return `達 ${percentage}% · 超出 ${formatNumber(Math.abs(progress.remaining))} ${nutrient.unit}`;
  }
  return `達 ${percentage}% · 已達建議值`;
}

function updateSummaryCircle(nutrient, value) {
  const circle = document.querySelector(`[data-summary-nutrient="${nutrient.key}"]`);
  if (!circle) return;
  const progress = getTargetProgress(value, nutrient);
  circle.classList.toggle("has-target", Boolean(progress));
  if (!progress) {
    circle.style.removeProperty("--progress-stop");
    circle.style.removeProperty("--excess-stop");
    circle.setAttribute("aria-label", `${nutrient.label} ${formatNutrient(value, nutrient)}`);
    return;
  }
  const percentage = Math.max(0, progress.percentage);
  const excessPercentage = Math.max(0, percentage - 100);
  circle.style.setProperty("--progress-stop", `${Math.min(100, percentage)}%`);
  circle.style.setProperty("--excess-stop", `${Math.min(100, excessPercentage)}%`);
  const excessLabel = excessPercentage > 0 ? `，超出建議值 ${formatNumber(excessPercentage)}%` : "";
  circle.setAttribute("aria-label", `${nutrient.label} ${formatNutrient(value, nutrient)}，達建議值 ${formatNumber(percentage)}%${excessLabel}`);
}

function mimeFromName(name) {
  const extension = name.split(".").pop()?.toLowerCase();
  return { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", heic: "image/heic", heif: "image/heif" }[extension] || "";
}

function normalizedMime(file) {
  const declared = String(file.type || "").toLowerCase();
  if (declared === "image/jpg") return "image/jpeg";
  return SERVER_IMAGE_TYPES.has(declared) ? declared : mimeFromName(file.name);
}

function isSupportedImage(file) {
  return String(file.type || "").startsWith("image/") || Boolean(mimeFromName(file.name));
}

function isHeic(file) {
  const type = normalizedMime(file);
  return type === "image/heic" || type === "image/heif";
}

function safeUploadName(name, fallbackExtension = "jpg") {
  let safe = String(name || "").replace(/[\x00-\x1f\x7f<>:"/\\|?*]/gu, "_").trim();
  if (!safe || safe === "." || safe === "..") safe = `food-${Date.now()}.${fallbackExtension}`;
  return Array.from(safe).slice(0, 120).join("");
}

function uniqueId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `photo-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("瀏覽器無法建立壓縮圖片。")), "image/jpeg", JPEG_QUALITY);
  });
}

function loadWithImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("圖片解碼失敗。")); };
    image.src = url;
  });
}

async function decodeImage(file) {
  if ("createImageBitmap" in globalThis) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); }
    catch {
      try { return await createImageBitmap(file); }
      catch { /* Fall through. */ }
    }
  }
  return loadWithImageElement(file);
}

async function prepareImage(file) {
  const originalMime = normalizedMime(file) || "application/octet-stream";
  if (isHeic(file)) return { blob: file, mimeType: originalMime, optimized: false, fallbackReason: "HEIC／HEIF 保留原檔" };
  let decoded;
  try {
    decoded = await decodeImage(file);
    const sourceWidth = decoded.width || decoded.naturalWidth;
    const sourceHeight = decoded.height || decoded.naturalHeight;
    if (!sourceWidth || !sourceHeight) throw new Error("圖片尺寸無效。");
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("瀏覽器無法處理圖片。");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(decoded, 0, 0, width, height);
    const blob = await canvasToBlob(canvas);
    if (SERVER_IMAGE_TYPES.has(originalMime) && file.size <= blob.size) {
      return { blob: file, mimeType: originalMime, optimized: false, fallbackReason: "原檔較小，保留原檔" };
    }
    return { blob, mimeType: "image/jpeg", optimized: true, fallbackReason: "" };
  } catch {
    return { blob: file, mimeType: originalMime, optimized: false, fallbackReason: "無法壓縮，保留原檔" };
  } finally {
    if (decoded && typeof decoded.close === "function") decoded.close();
  }
}

function setProgress(title, detail) {
  dom.progressTitle.textContent = title;
  dom.progressDetail.textContent = detail;
  dom.progressPanel.hidden = false;
}

function showError(message) {
  dom.errorMessage.textContent = message;
  dom.errorPanel.hidden = false;
}

function clearError() {
  dom.errorMessage.textContent = "";
  dom.errorPanel.hidden = true;
}

function resetTopSummary() {
  dom.topTotalCalories.textContent = "—";
  dom.topTotalCalories.style.removeProperty("--top-calorie-font-size");
  dom.topProtein.textContent = "—";
  dom.topCarbs.textContent = "—";
  dom.topFat.textContent = "—";
  for (const circle of document.querySelectorAll("[data-summary-nutrient]")) {
    circle.classList.remove("has-target");
    circle.style.removeProperty("--progress-stop");
    circle.style.removeProperty("--excess-stop");
  }
}

function renderTopSummary(totals) {
  const calorieText = formatNumber(totals.calories_kcal);
  dom.topTotalCalories.textContent = calorieText;
  const fittedSize = Math.max(17, Math.min(35, 112 / Math.max(1, calorieText.length * 0.58)));
  dom.topTotalCalories.style.setProperty("--top-calorie-font-size", `${fittedSize}px`);
  dom.topProtein.textContent = formatNumber(totals.protein_g);
  dom.topCarbs.textContent = formatNumber(totals.carbs_g);
  dom.topFat.textContent = formatNumber(totals.fat_g);
  for (const nutrient of NUTRIENTS.filter(item => ["calories_kcal", "protein_g", "carbs_g", "fat_g"].includes(item.key))) {
    updateSummaryCircle(nutrient, totals[nutrient.key]);
  }
}

function invalidateResult() {
  state.result = null;
  dom.results.hidden = true;
  for (const analysis of dom.mealSections.querySelectorAll(".meal-result-embedded")) analysis.remove();
  resetTopSummary();
}

function updateCalculateButton() {
  const analyzing = Boolean(state.analysisController);
  dom.calculateButton.disabled = state.busy ? !analyzing : !hasMealContent();
  dom.calculateButton.classList.toggle("is-cancel", analyzing);
  dom.calculateButton.setAttribute("aria-label", analyzing ? "暫停並中斷目前的營養分析" : "計算熱量");
  dom.calculateButton.querySelector("span").textContent = analyzing
    ? "暫停處理"
    : "計算熱量";
  dom.calculateButton.querySelector("svg path").setAttribute("d", analyzing ? "M8 6v12M16 6v12" : "m9 18 6-6-6-6");
}

function setBusy(busy) {
  state.busy = busy;
  dom.appShell.classList.toggle("is-busy", busy);
  dom.appShell.setAttribute("aria-busy", String(busy));
  dom.cameraInput.disabled = busy;
  dom.galleryInput.disabled = busy;
  updateCalculateButton();
  dom.exportImageButton.disabled = busy;
  for (const control of dom.mealSections.querySelectorAll("button, textarea")) control.disabled = busy;
  for (const control of dom.mealResults.querySelectorAll("button")) control.disabled = busy;
  if (!busy) dom.progressPanel.hidden = true;
}

function updateControls() {
  const count = state.photos.length;
  const mealCount = MEALS.filter(meal => state.photos.some(photo => photo.mealType === meal.id) || state.mealNotes[meal.id]?.trim()).length;
  const isToday = state.activeDate === localDateKey();
  dom.photoCount.textContent = `${count} / ${MAX_TOTAL_PHOTOS}`;
  dom.activeDateLabel.textContent = `${isToday ? "今日紀錄" : "日曆紀錄"} · ${formatRecordDate(state.activeDate)}`;
  dom.photoHeading.textContent = isToday ? "安排今天的餐點" : "編輯這一天的餐點";
  dom.returnTodayButton.hidden = isToday;
  updateCalculateButton();
  dom.actionContext.replaceChildren(
    makeElement("span", "", mealCount ? `已記錄 ${mealCount} 個餐次、${count} 張照片` : "尚未加入照片或備註"),
    makeElement("small", "", count ? `這一天還可加入 ${MAX_TOTAL_PHOTOS - count} 張` : "可只寫餐次備註；每餐也可加入多張照片"),
  );
}

async function takeNativePhoto(mealId) {
  try {
    const captured = await Camera.getPhoto({
      source: CameraSource.Camera,
      direction: CameraDirection.Rear,
      resultType: CameraResultType.Uri,
      quality: 90,
      allowEditing: false,
      correctOrientation: true,
      saveToGallery: false,
    });
    if (!captured.webPath) throw new Error("相機沒有回傳可讀取的照片。");
    const response = await fetch(captured.webPath);
    if (!response.ok) throw new Error("無法讀取剛拍攝的照片。");
    const blob = await response.blob();
    const extension = String(captured.format || "jpeg").toLowerCase().replace("jpg", "jpeg");
    const mimeType = blob.type || `image/${extension}`;
    const filenameExtension = extension === "jpeg" ? "jpg" : extension;
    const file = new File([blob], `camera-${Date.now()}.${filenameExtension}`, { type: mimeType });
    await addFiles([file]);
  } catch (error) {
    if (/cancel(?:ed|led)?|取消/iu.test(String(error?.message || error))) return;
    showError(error?.message || "無法開啟相機，請檢查相機權限後再試。");
  }
}

function chooseFiles(mealId, source) {
  if (state.busy || state.photos.length >= MAX_TOTAL_PHOTOS) return;
  if (state.photos.filter(photo => photo.mealType === mealId).length >= MAX_PHOTOS_PER_MEAL) {
    showError(`${MEAL_MAP.get(mealId).label}最多可加入 ${MAX_PHOTOS_PER_MEAL} 張照片。`);
    return;
  }
  state.activeMealId = mealId;
  state.expandedPhotoMeals.add(mealId);
  if (source === "camera" && Capacitor.isNativePlatform()) {
    takeNativePhoto(mealId);
    return;
  }
  (source === "camera" ? dom.cameraInput : dom.galleryInput).click();
}

function makeAddButton(meal, source) {
  const camera = source === "camera";
  const button = makeElement("button", `meal-add-button${camera ? " meal-camera-button" : ""}`);
  button.type = "button";
  button.append(
    makeSvg(camera
      ? "M4 7.5h3l1.4-2h7.2l1.4 2h3a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.5a2 2 0 0 1 2-2Zm8 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"
      : "M4 4h16v16H4V4Zm2 13 4-4 3 3 2-2 3 3M8.5 9.5h.01"),
    makeElement("span", "", camera ? "拍照" : "相簿"),
  );
  button.setAttribute("aria-label", `${meal.label}：${camera ? "拍照" : "從相簿選擇"}`);
  const mealCount = state.photos.filter(photo => photo.mealType === meal.id).length;
  button.disabled = state.busy || mealCount >= MAX_PHOTOS_PER_MEAL || state.photos.length >= MAX_TOTAL_PHOTOS;
  button.addEventListener("click", () => chooseFiles(meal.id, source));
  return button;
}

function makePhotoCard(photo, mealIndex) {
  const card = makeElement("article", "photo-card meal-photo-card");
  const preview = makeElement("div", "photo-preview");
  const image = makeElement("img");
  image.src = photo.previewUrl;
  image.alt = `${MEAL_MAP.get(photo.mealType).label}第 ${mealIndex + 1} 張照片：${photo.name}`;
  const fallback = makeElement("div", "preview-fallback");
  fallback.hidden = true;
  fallback.append(makeSvg("M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13ZM7 16l3.5-4 2.7 2.8 1.8-2 2 3.2"), makeElement("span", "", "無法預覽，仍可分析"));
  image.addEventListener("error", () => { image.classList.add("preview-unavailable"); fallback.hidden = false; }, { once: true });
  const openPreview = makeElement("button", "photo-open-button");
  openPreview.type = "button";
  openPreview.setAttribute("aria-label", `查看${MEAL_MAP.get(photo.mealType).label}第 ${mealIndex + 1} 張完整照片`);
  openPreview.title = "查看完整照片";
  openPreview.addEventListener("click", () => openPhotoViewer(photo.blob, photo.name));
  const previewHint = makeElement("span", "photo-preview-hint", "點擊查看完整照片");
  const number = makeElement("span", "photo-index", String(mealIndex + 1).padStart(2, "0"));
  const remove = makeElement("button", "remove-button", "×");
  remove.type = "button";
  remove.setAttribute("aria-label", `移除 ${MEAL_MAP.get(photo.mealType).label}照片 ${photo.name}`);
  remove.disabled = state.busy;
  remove.addEventListener("click", () => removePhoto(photo.id));
  preview.append(image, fallback, openPreview, previewHint, number, remove);

  const body = makeElement("div", "photo-body");
  const meta = makeElement("div", "photo-meta");
  const filename = makeElement("strong", "", photo.name);
  filename.title = photo.name;
  meta.append(filename, makeElement("span", "", photo.optimized ? `已最佳化 · ${formatBytes(photo.blob.size)}` : `${photo.fallbackReason || "原始檔"} · ${formatBytes(photo.blob.size)}`));
  body.append(meta);
  card.append(preview, body);
  return card;
}

function renderMealSections() {
  dom.mealSections.replaceChildren();
  for (const meal of MEALS) {
    const photos = state.photos.filter(photo => photo.mealType === meal.id);
    const section = makeElement("section", `meal-section meal-${meal.id}`);
    section.setAttribute("aria-labelledby", `meal-title-${meal.id}`);
    const header = makeElement("div", "meal-section-header");
    const identity = makeElement("div", "meal-identity");
    const icon = makeElement("span", "meal-icon", meal.icon);
    icon.setAttribute("aria-hidden", "true");
    const copy = makeElement("div");
    const title = makeElement("h3", "", meal.label);
    title.id = `meal-title-${meal.id}`;
    copy.append(title, makeElement("p", "", meal.hint));
    identity.append(icon, copy);
    header.append(identity, makeElement("span", "meal-photo-count", `${photos.length} 張`));
    const noteField = makeElement("div", "meal-note-field");
    const noteLabel = makeElement("label", "note-label");
    noteLabel.htmlFor = `meal-note-${meal.id}`;
    noteLabel.append(makeElement("span", "", "本餐共用備註"), makeElement("span", "optional-label", "可不附照片"));
    const note = makeElement("textarea", "note-input meal-note-input");
    note.id = `meal-note-${meal.id}`;
    note.maxLength = NOTE_MAX_LENGTH;
    note.rows = 3;
    note.placeholder = "例如：白飯半碗、雞胸肉 120g、醬汁吃一半；沒拍照也可直接描述餐點…";
    note.value = state.mealNotes[meal.id] || "";
    note.disabled = state.busy;
    let noteSaveTimer;
    let lastQueuedNote = note.value.trim();
    const saveFinishedNote = () => {
      clearTimeout(noteSaveTimer);
      noteSaveTimer = undefined;
      const currentNote = state.mealNotes[meal.id].trim();
      if (currentNote === lastQueuedNote) return;
      lastQueuedNote = currentNote;
      queueCurrentHistorySave().catch(error => {
        lastQueuedNote = null;
        showError(`備註已保留在畫面，但自動儲存失敗：${error?.message || "請稍後再試。"}`);
      });
    };
    note.addEventListener("input", event => {
      state.mealNotes[meal.id] = event.currentTarget.value;
      delete state.mealAnalysisCache[meal.id];
      if (state.result) invalidateResult();
      updateControls();
      clearTimeout(noteSaveTimer);
      noteSaveTimer = window.setTimeout(saveFinishedNote, 700);
    });
    note.addEventListener("change", saveFinishedNote);
    noteField.append(noteLabel, note);
    const photoDetails = makeElement("details", "meal-photo-details");
    photoDetails.open = state.expandedPhotoMeals.has(meal.id);
    photoDetails.addEventListener("toggle", () => {
      if (photoDetails.open) state.expandedPhotoMeals.add(meal.id);
      else state.expandedPhotoMeals.delete(meal.id);
    });
    const photoSummary = makeElement("summary", "meal-photo-summary");
    const photoSummaryCopy = makeElement("span");
    photoSummaryCopy.append(
      makeElement("strong", "", "照片"),
      makeElement("small", "", photos.length ? `${photos.length} 張 · 點擊展開或收起` : "尚未加入 · 點擊展開"),
    );
    photoSummary.append(photoSummaryCopy, makeElement("span", "meal-photo-summary-count", String(photos.length)));
    const photoContent = makeElement("div", "meal-photo-content");
    const actions = makeElement("div", "meal-add-actions");
    actions.append(makeAddButton(meal, "camera"), makeAddButton(meal, "gallery"));
    if (photos.length || state.mealNotes[meal.id]?.trim()) {
      const clear = makeElement("button", "meal-clear-button", "清除此餐");
      clear.type = "button";
      clear.disabled = state.busy;
      clear.addEventListener("click", () => clearMeal(meal.id));
      actions.append(clear);
    }
    const list = makeElement("div", "meal-photo-list");
    if (photos.length) photos.forEach((photo, index) => list.append(makePhotoCard(photo, index)));
    else {
      const empty = makeElement("div", "meal-empty");
      empty.append(makeElement("span", "", "+"), makeElement("p", "", `可為${meal.label}加入照片，或只使用上方備註`));
      list.append(empty);
    }
    photoContent.append(actions, list);
    photoDetails.append(photoSummary, photoContent);
    section.append(header, noteField, photoDetails);
    const mealAnalysis = state.result?.meals?.find(resultMeal => resultMeal.id === meal.id);
    if (mealAnalysis) section.append(makeMealResult(mealAnalysis, { embedded: true }));
    dom.mealSections.append(section);
  }
  updateControls();
}

function removePhoto(id) {
  if (state.busy) return;
  const index = state.photos.findIndex(photo => photo.id === id);
  if (index < 0) return;
  const mealId = state.photos[index].mealType;
  URL.revokeObjectURL(state.photos[index].previewUrl);
  state.photos.splice(index, 1);
  delete state.mealAnalysisCache[mealId];
  invalidateResult();
  clearError();
  renderMealSections();
  queueCurrentHistorySave().catch(error => showError(`照片已移除，但自動儲存失敗：${error?.message || "請稍後再試。"}`));
}

function clearMeal(mealId) {
  if (state.busy) return;
  state.photos.filter(photo => photo.mealType === mealId).forEach(photo => URL.revokeObjectURL(photo.previewUrl));
  state.photos = state.photos.filter(photo => photo.mealType !== mealId);
  state.mealNotes[mealId] = "";
  delete state.mealAnalysisCache[mealId];
  invalidateResult();
  clearError();
  renderMealSections();
  queueCurrentHistorySave().catch(error => showError(`餐次已清除，但自動儲存失敗：${error?.message || "請稍後再試。"}`));
}

function releasePhotos() {
  state.photos.forEach(photo => URL.revokeObjectURL(photo.previewUrl));
  state.photos.length = 0;
}

async function addFiles(fileList) {
  if (state.busy) return;
  clearError();
  invalidateResult();
  const incoming = [...fileList];
  if (!incoming.length) return;
  const meal = MEAL_MAP.get(state.activeMealId);
  state.expandedPhotoMeals.add(meal.id);
  const currentMealCount = state.photos.filter(photo => photo.mealType === meal.id).length;
  const available = Math.min(MAX_PHOTOS_PER_MEAL - currentMealCount, MAX_TOTAL_PHOTOS - state.photos.length);
  const selected = incoming.slice(0, available);
  const problems = [];
  let addedCount = 0;
  if (incoming.length > available) problems.push(`${meal.label}或今日照片數已達上限，超出的照片未加入。`);
  setBusy(true);
  try {
    for (let index = 0; index < selected.length; index += 1) {
      const file = selected[index];
      setProgress(`正在準備${meal.label}照片`, `處理第 ${index + 1} / ${selected.length} 張：${file.name}`);
      if (!isSupportedImage(file)) { problems.push(`${file.name} 不是支援的圖片。`); continue; }
      if (!file.size) { problems.push(`${file.name} 是空檔案。`); continue; }
      if (file.size > MAX_IMAGE_BYTES) { problems.push(`${file.name} 超過 14 MB，請先縮小。`); continue; }
      const prepared = await prepareImage(file);
      if (!SERVER_IMAGE_TYPES.has(prepared.mimeType)) { problems.push(`${file.name} 無法轉成支援的圖片格式。`); continue; }
      if (!prepared.blob.size || prepared.blob.size > MAX_IMAGE_BYTES) { problems.push(`${file.name} 處理後仍超過 14 MB。`); continue; }
      const currentBytes = state.photos.reduce((sum, photo) => sum + photo.blob.size, 0);
      if (currentBytes + prepared.blob.size > MAX_TOTAL_IMAGE_BYTES) { problems.push(`今日照片總大小不可超過 35 MB；${file.name} 未加入。`); continue; }
      state.photos.push({
        id: uniqueId(), mealType: meal.id, name: file.name, uploadName: safeUploadName(file.name),
        blob: prepared.blob, mimeType: prepared.mimeType, previewUrl: URL.createObjectURL(prepared.blob),
        optimized: prepared.optimized, fallbackReason: prepared.fallbackReason,
        dataBase64: await blobToBase64(prepared.blob),
      });
      addedCount += 1;
    }
    if (addedCount) {
      delete state.mealAnalysisCache[meal.id];
      setProgress("正在自動儲存當日紀錄", "照片已加入，正在寫入當日 JSON");
      await queueCurrentHistorySave();
    }
  } catch (error) {
    problems.push(`照片已加入，但自動儲存失敗：${error?.message || "請稍後再試。"}`);
  } finally {
    setBusy(false);
    dom.cameraInput.value = "";
    dom.galleryInput.value = "";
    renderMealSections();
  }
  if (problems.length) showError(problems.join(" "));
}

function blobToBase64(blob, signal) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const onAbort = () => {
      if (reader.readyState === FileReader.LOADING) reader.abort();
      cleanup();
      reject(new DOMException("營養分析已由使用者中止。", "AbortError"));
    };
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    reader.onload = () => {
      cleanup();
      const value = String(reader.result || "");
      const comma = value.indexOf(",");
      if (comma < 0) reject(new Error("無法讀取圖片內容。"));
      else resolve(value.slice(comma + 1));
    };
    reader.onerror = () => { cleanup(); reject(new Error("讀取圖片時發生錯誤。")); };
    reader.onabort = cleanup;
    reader.readAsDataURL(blob);
  });
}

function generatedReportFileName(date) {
  return `今日營養報告-${date}.jpg`;
}

function generatedReportCacheUrl(date) {
  return new URL(`.generated-reports/${encodeURIComponent(date)}.jpg`, window.location.href).href;
}

function legacyGeneratedReportFileName(date) {
  return `今日營養報告-${date}.png`;
}

function legacyGeneratedReportCacheUrl(date) {
  return new URL(`.generated-reports/${encodeURIComponent(date)}.png`, window.location.href).href;
}

async function saveGeneratedReport(date, image) {
  if (Capacitor.isNativePlatform()) {
    await Filesystem.writeFile({
      path: `${GENERATED_REPORT_DIRECTORY}/${generatedReportFileName(date)}`,
      data: await blobToBase64(image.blob),
      directory: Directory.Data,
      recursive: true,
    });
    try {
      await Filesystem.deleteFile({
        path: `${GENERATED_REPORT_DIRECTORY}/${legacyGeneratedReportFileName(date)}`,
        directory: Directory.Data,
      });
    } catch {
      // Older versions may not have generated a PNG report for this date.
    }
    return;
  }
  if (STATIC_HOSTED_WEB) {
    await saveStaticReport(date, image);
    return;
  }
  if (!("caches" in window)) return;
  const cache = await caches.open(GENERATED_REPORT_CACHE);
  await cache.put(generatedReportCacheUrl(date), new Response(image.blob, {
    headers: { "Content-Type": image.mimeType || image.blob.type || "image/jpeg", "Cache-Control": "no-store" },
  }));
  await cache.delete(legacyGeneratedReportCacheUrl(date));
}

async function readGeneratedReport(date) {
  if (Capacitor.isNativePlatform()) {
    for (const candidate of [
      { fileName: generatedReportFileName(date), mimeType: "image/jpeg" },
      { fileName: legacyGeneratedReportFileName(date), mimeType: "image/png" },
    ]) {
      try {
        const stored = await Filesystem.readFile({
          path: `${GENERATED_REPORT_DIRECTORY}/${candidate.fileName}`,
          directory: Directory.Data,
        });
        const blob = stored.data instanceof Blob ? stored.data : base64ToBlob(String(stored.data), candidate.mimeType);
        return { blob, fileName: candidate.fileName, mimeType: candidate.mimeType };
      } catch {
        // Try the current or legacy filename.
      }
    }
    return null;
  }
  if (STATIC_HOSTED_WEB) {
    const stored = await readStaticReport(date);
    return stored ? { blob: stored.blob, fileName: stored.fileName, mimeType: stored.mimeType } : null;
  }
  if (!("caches" in window)) return null;
  const cache = await caches.open(GENERATED_REPORT_CACHE);
  const current = await cache.match(generatedReportCacheUrl(date));
  if (current) return { blob: await current.blob(), fileName: generatedReportFileName(date), mimeType: "image/jpeg" };
  const legacy = await cache.match(legacyGeneratedReportCacheUrl(date));
  return legacy ? { blob: await legacy.blob(), fileName: legacyGeneratedReportFileName(date), mimeType: "image/png" } : null;
}

async function generatedReportExists(date) {
  if (Capacitor.isNativePlatform()) {
    for (const fileName of [generatedReportFileName(date), legacyGeneratedReportFileName(date)]) {
      try {
        await Filesystem.stat({
          path: `${GENERATED_REPORT_DIRECTORY}/${fileName}`,
          directory: Directory.Data,
        });
        return true;
      } catch {
        // Try the other supported filename.
      }
    }
    return false;
  }
  if (STATIC_HOSTED_WEB) return Boolean(await readStaticReport(date));
  if (!("caches" in window)) return false;
  const cache = await caches.open(GENERATED_REPORT_CACHE);
  return Boolean(await cache.match(generatedReportCacheUrl(date)) || await cache.match(legacyGeneratedReportCacheUrl(date)));
}

async function deleteGeneratedReport(date) {
  if (Capacitor.isNativePlatform()) {
    for (const fileName of [generatedReportFileName(date), legacyGeneratedReportFileName(date)]) {
      try {
        await Filesystem.deleteFile({
          path: `${GENERATED_REPORT_DIRECTORY}/${fileName}`,
          directory: Directory.Data,
        });
      } catch {
        // The date may never have had an exported report with this extension.
      }
    }
    return;
  }
  if (STATIC_HOSTED_WEB) {
    await deleteStaticReport(date);
    return;
  }
  if ("caches" in window) {
    const cache = await caches.open(GENERATED_REPORT_CACHE);
    await Promise.all([
      cache.delete(generatedReportCacheUrl(date)),
      cache.delete(legacyGeneratedReportCacheUrl(date)),
    ]);
  }
}

function loadGalleryExportIds() {
  try {
    const value = JSON.parse(localStorage.getItem(GALLERY_EXPORT_IDS_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function storeGalleryExportId(key, identifier) {
  if (!identifier) return;
  try {
    const identifiers = loadGalleryExportIds();
    identifiers[key] = identifier;
    localStorage.setItem(GALLERY_EXPORT_IDS_KEY, JSON.stringify(identifiers));
  } catch {
    // Gallery replacement still works by filename on Android.
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("無法讀取匯出圖片的內容。"));
    reader.readAsDataURL(blob);
  });
}

function imageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("無法建立完整頁面圖片。"));
    image.src = url;
  });
}

function canvasToPng(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("瀏覽器無法輸出 PNG 圖片。"));
    }, "image/png");
  });
}

async function inlineCloneImages(source, clone) {
  const sourceImages = [...source.querySelectorAll("img")];
  const cloneImages = [...clone.querySelectorAll("img")];
  await Promise.all(sourceImages.map(async (sourceImage, index) => {
    const cloneImage = cloneImages[index];
    const sourceUrl = sourceImage.currentSrc || sourceImage.src;
    if (!cloneImage || !sourceUrl) return;
    const matchingPhoto = state.photos.find(photo => photo.previewUrl === sourceUrl || photo.previewUrl === sourceImage.src);
    if (matchingPhoto) {
      cloneImage.src = await blobToDataUrl(matchingPhoto.blob);
      return;
    }
    if (sourceUrl.startsWith("data:")) {
      cloneImage.src = sourceUrl;
      return;
    }
    const response = await fetch(sourceUrl);
    if (!response.ok) throw new Error("有一張照片無法加入匯出圖片。請重新載入頁面後再試。");
    cloneImage.src = await blobToDataUrl(await response.blob());
  }));
}

async function buildPageImageBlob() {
  const source = dom.appShell;
  const width = Math.ceil(source.getBoundingClientRect().width);
  if (!width) throw new Error("目前頁面無法匯出，請重新載入後再試。");

  const clone = source.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/1999/xhtml");
  clone.classList.add("export-canvas");

  const sourceTextareas = [...source.querySelectorAll("textarea")];
  [...clone.querySelectorAll("textarea")].forEach((textarea, index) => {
    textarea.textContent = sourceTextareas[index]?.value || "";
  });
  const sourceInputs = [...source.querySelectorAll("input")];
  [...clone.querySelectorAll("input")].forEach((input, index) => {
    const sourceInput = sourceInputs[index];
    if (!sourceInput) return;
    if (sourceInput.type === "checkbox" || sourceInput.type === "radio") {
      if (sourceInput.checked) input.setAttribute("checked", "");
      else input.removeAttribute("checked");
    } else input.setAttribute("value", sourceInput.value);
  });

  const stylesheetResponse = await fetch("/styles.css", { cache: "no-cache" });
  if (!stylesheetResponse.ok) throw new Error("無法載入頁面樣式，請重新載入後再試。");
  const style = document.createElement("style");
  style.textContent = `${await stylesheetResponse.text()}
    .export-canvas {
      width: ${width}px !important;
      max-width: none !important;
      min-height: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
    }
    .export-canvas .sticky-action {
      position: static !important;
      right: auto !important;
      bottom: auto !important;
      left: auto !important;
      width: auto !important;
      transform: none !important;
      border-right: 0 !important;
      border-bottom-right-radius: 0 !important;
      border-bottom-left-radius: 0 !important;
    }
    .export-canvas footer { padding-bottom: 22px !important; }
    .export-canvas dialog { display: none !important; }
    .export-canvas *, .export-canvas *::before, .export-canvas *::after {
      animation: none !important;
      transition: none !important;
      caret-color: transparent !important;
    }
  `;
  clone.prepend(style);

  const clonedExportButton = clone.querySelector("#export-image-button");
  if (clonedExportButton) {
    clonedExportButton.disabled = false;
    const label = clonedExportButton.querySelector("span");
    if (label) label.textContent = "匯出報告";
  }
  await inlineCloneImages(source, clone);

  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;visibility:hidden;pointer-events:none;z-index:-1`;
  host.append(clone);
  document.body.append(host);

  let height;
  let markup;
  try {
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    height = Math.ceil(Math.max(clone.scrollHeight, clone.getBoundingClientRect().height));
    markup = new XMLSerializer().serializeToString(clone);
  } finally {
    host.remove();
  }
  if (!height) throw new Error("目前頁面沒有可匯出的內容。");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
  const svgUrl = await blobToDataUrl(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const image = await imageFromUrl(svgUrl);
  const maxSide = 16_384;
  const maxPixels = 64_000_000;
  const scale = Math.min(2, maxSide / width, maxSide / height, Math.sqrt(maxPixels / (width * height)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("瀏覽器無法建立圖片畫布。");
  context.scale(scale, scale);
  context.fillStyle = "#f8f6f0";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return await canvasToPng(canvas);
}

function closeExportDialog() {
  if (typeof dom.exportDialog.close === "function" && dom.exportDialog.open) dom.exportDialog.close();
  else dom.exportDialog.removeAttribute("open");
}

async function openExportDialog() {
  if (state.busy || dom.exportImageButton.disabled) return;
  const date = state.activeDate;
  dom.previewSavedReportButton.hidden = true;
  if (typeof dom.exportDialog.showModal === "function") dom.exportDialog.showModal();
  else dom.exportDialog.setAttribute("open", "");
  try {
    const exists = await generatedReportExists(date);
    if (state.activeDate === date && dom.exportDialog.open) dom.previewSavedReportButton.hidden = !exists;
  } catch {
    dom.previewSavedReportButton.hidden = true;
  }
}

async function previewSavedReport() {
  const date = state.activeDate;
  closeExportDialog();
  clearError();
  try {
    const image = await readGeneratedReport(date);
    if (!image) throw new Error("找不到這個日期已產生的報告，請重新匯出一次。");
    openPhotoViewer(image.blob, `全天營養報告 · ${date}`);
  } catch (error) {
    showError(error?.message || "無法打開已產生的報告。");
  }
}

async function exportPageImage(destination, mode = "report") {
  if (state.busy || dom.exportImageButton.disabled) return;
  closeExportDialog();
  clearError();
  const label = dom.exportImageButton.querySelector("span");
  const originalLabel = label?.textContent || "匯出報告";
  let completedLabel = "";
  dom.exportImageButton.disabled = true;
  dom.saveGalleryButton.disabled = true;
  dom.shareExportButton.disabled = true;
  dom.longExportButton.disabled = true;
  dom.previewSavedReportButton.disabled = true;
  dom.exportImageButton.setAttribute("aria-busy", "true");
  if (label) label.textContent = "產生中…";
  try {
    const images = mode === "full"
      ? [{ blob: await buildPageImageBlob(), fileName: `完整營養紀錄-${state.activeDate}.png` }]
      : await buildMealReportImages({
        date: state.activeDate,
        dateLabel: formatRecordDate(state.activeDate),
        totals: state.result?.totals || {},
        nutritionTargets: state.nutritionTargets,
        meals: state.result?.meals || [],
        resultPhotos: state.result?.photos || [],
        sourcePhotos: state.photos,
      });
    if (mode === "report") await saveGeneratedReport(state.activeDate, images[0]);
    if (destination === "gallery" && Capacitor.isNativePlatform()) {
      const galleryIds = loadGalleryExportIds();
      for (const image of images) {
        const galleryKey = `${mode}:${state.activeDate}`;
        const saved = await GallerySaver.saveImage({
          data: await blobToBase64(image.blob),
          filename: image.fileName,
          mimeType: image.mimeType || image.blob.type || "image/png",
          replaceIdentifier: galleryIds[galleryKey] || "",
        });
        storeGalleryExportId(galleryKey, saved?.uri);
      }
      completedLabel = images.length > 1 ? `已存 ${images.length} 張` : "已存到相簿";
    } else if (destination === "share" && Capacitor.isNativePlatform()) {
      const files = [];
      for (const image of images) {
        const saved = await Filesystem.writeFile({
          path: `nutrition-exports/${image.fileName}`,
          data: await blobToBase64(image.blob),
          directory: Directory.Documents,
          recursive: true,
        });
        files.push(saved.uri);
      }
      await Share.share({
        title: `餐盤小幫手 · ${state.activeDate}`,
        text: mode === "full" ? "完整營養紀錄圖片" : "全天營養報告",
        files,
        dialogTitle: "分享營養紀錄",
      });
      completedLabel = "分享完成";
    } else if (destination === "share" && typeof navigator.share === "function") {
      const files = images.map(image => new File(
        [image.blob],
        image.fileName,
        { type: image.mimeType || image.blob.type || "image/png" },
      ));
      if (typeof navigator.canShare !== "function" || navigator.canShare({ files })) {
        await navigator.share({ title: `餐盤小幫手 · ${state.activeDate}`, text: "全天營養報告", files });
        completedLabel = "分享完成";
      }
    }
    if (!completedLabel) {
      for (const image of images) {
        const url = URL.createObjectURL(image.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = image.fileName;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      completedLabel = images.length > 1 ? `已下載 ${images.length} 張` : "已下載圖片";
    }
    showExportCompleteDialog(images[0], completedLabel);
  } catch (error) {
    showError(error?.message || "產生營養報告圖片時發生錯誤，請稍後再試。");
    dom.errorPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  } finally {
    dom.exportImageButton.disabled = state.busy;
    dom.saveGalleryButton.disabled = false;
    dom.shareExportButton.disabled = false;
    dom.longExportButton.disabled = false;
    dom.previewSavedReportButton.disabled = false;
    dom.exportImageButton.removeAttribute("aria-busy");
    if (label) {
      label.textContent = completedLabel || originalLabel;
      if (completedLabel) window.setTimeout(() => {
        if (label.textContent === completedLabel) label.textContent = originalLabel;
      }, 2400);
    }
  }
}

function makeNutrientAmount(nutrient, value, className = "") {
  const box = makeElement("div", className);
  box.append(makeElement("strong", "", formatNumber(nutritionNumber(value))), makeElement("span", "", `${nutrient.label} ${nutrient.unit}`));
  return box;
}

function appendNutrientCard(nutrient, value) {
  const card = makeElement("article", `nutrient-card nutrient-${nutrient.tone}`);
  card.dataset.nutrientKey = nutrient.key;
  const label = makeElement("div", "nutrient-card-label");
  label.append(makeElement("span", "nutrient-dot"), makeElement("span", "", nutrient.label));
  const amount = makeElement("p");
  const targetStatus = makeElement("span", "nutrient-target-status");
  const statusText = targetStatusText(value, nutrient);
  targetStatus.textContent = statusText;
  targetStatus.hidden = !statusText;
  amount.append(
    makeElement("strong", "", formatNumber(nutritionNumber(value))),
    makeElement("small", "", nutrient.unit),
    targetStatus,
  );
  card.append(label, amount);
  dom.nutrientGrid.append(card);
}

function refreshRecommendationDisplays() {
  if (!state.result?.totals) {
    resetTopSummary();
    return;
  }
  const totals = state.result.totals;
  renderTopSummary(totals);
  for (const card of dom.nutrientGrid.querySelectorAll("[data-nutrient-key]")) {
    const nutrient = NUTRIENTS.find(item => item.key === card.dataset.nutrientKey);
    const status = card.querySelector(".nutrient-target-status");
    if (!nutrient || !status) continue;
    const text = targetStatusText(totals[nutrient.key], nutrient);
    status.textContent = text;
    status.hidden = !text;
  }
}

function closeSettingsDialog() {
  if (typeof dom.nutritionSettingsDialog.close === "function" && dom.nutritionSettingsDialog.open) {
    dom.nutritionSettingsDialog.close();
  } else {
    dom.nutritionSettingsDialog.removeAttribute("open");
  }
}

function openSettingsDialog() {
  dom.geminiApiKey.value = state.connection.apiKey;
  dom.splitFoodItems.checked = state.connection.splitItems !== false;
  dom.geminiApiKey.type = "password";
  dom.toggleApiKey.textContent = "顯示";
  dom.toggleApiKey.setAttribute("aria-label", "顯示 API key");
  for (const input of dom.nutritionSettingsForm.querySelectorAll("[data-target-key]")) {
    const value = state.nutritionTargets[input.dataset.targetKey];
    input.value = typeof value === "number" ? String(value) : "";
  }
  refreshHistoryDates().catch(() => {
    dom.historyRecordCount.textContent = "暫時無法讀取歷史紀錄";
  });
  if (typeof dom.nutritionSettingsDialog.showModal === "function") dom.nutritionSettingsDialog.showModal();
  else dom.nutritionSettingsDialog.setAttribute("open", "");
}

function closeApiKeyGuide() {
  if (typeof dom.apiKeyGuideDialog.close === "function" && dom.apiKeyGuideDialog.open) {
    dom.apiKeyGuideDialog.close();
  } else {
    dom.apiKeyGuideDialog.removeAttribute("open");
  }
  if (typeof dom.nutritionSettingsDialog.showModal === "function") dom.nutritionSettingsDialog.showModal();
  else dom.nutritionSettingsDialog.setAttribute("open", "");
}

function openApiKeyGuide() {
  closeSettingsDialog();
  if (typeof dom.apiKeyGuideDialog.showModal === "function") dom.apiKeyGuideDialog.showModal();
  else dom.apiKeyGuideDialog.setAttribute("open", "");
}

function updateConnectionStatus() {
  const ready = Boolean(state.connection.apiKey);
  dom.connectionStatus.textContent = ready ? "已設定" : "尚未設定";
  dom.connectionStatus.classList.toggle("is-ready", ready);
}

function storeConnectionSettings(connection) {
  state.connection = connection;
  try { localStorage.setItem(CONNECTION_STORAGE_KEY, JSON.stringify(connection)); }
  catch {
    // The values still apply for this page when storage is unavailable.
  }
  updateConnectionStatus();
}

function storeNutritionTargets(targets) {
  state.nutritionTargets = targets;
  try {
    if (Object.keys(targets).length) localStorage.setItem(TARGET_STORAGE_KEY, JSON.stringify(targets));
    else localStorage.removeItem(TARGET_STORAGE_KEY);
  } catch {
    // The settings still apply for this page when storage is unavailable.
  }
  refreshRecommendationDisplays();
}

function saveNutritionTargets(event) {
  event.preventDefault();
  if (!dom.nutritionSettingsForm.reportValidity()) return;
  const targets = {};
  for (const input of dom.nutritionSettingsForm.querySelectorAll("[data-target-key]")) {
    if (!input.value.trim()) continue;
    const value = Number(input.value);
    if (Number.isFinite(value) && value > 0) targets[input.dataset.targetKey] = value;
  }
  storeConnectionSettings({
    apiKey: dom.geminiApiKey.value.trim(),
    splitItems: dom.splitFoodItems.checked,
  });
  storeNutritionTargets(targets);
  closeSettingsDialog();
  refreshHistoryDates().catch(() => {});
}

function clearNutritionTargets() {
  for (const input of dom.nutritionSettingsForm.querySelectorAll("[data-target-key]")) input.value = "";
  storeNutritionTargets({});
}

function toggleApiKeyVisibility() {
  const visible = dom.geminiApiKey.type === "text";
  dom.geminiApiKey.type = visible ? "password" : "text";
  dom.toggleApiKey.textContent = visible ? "顯示" : "隱藏";
  dom.toggleApiKey.setAttribute("aria-label", visible ? "顯示 API key" : "隱藏 API key");
}

function updateSplitItemsSetting() {
  storeConnectionSettings({
    apiKey: state.connection.apiKey,
    splitItems: dom.splitFoodItems.checked,
  });
}

function updateHistoryCount() {
  const count = state.historyDates.size;
  dom.historyRecordCount.textContent = count ? `已有 ${count} 天紀錄 · 可查看或新增日期` : "選擇日期建立第一筆紀錄";
}

async function saveNativeHistoryRecord(date, images, mealNotes, mealAnalysisCache, result) {
  await Filesystem.writeFile({
    path: `history/${date}.json`,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
    recursive: true,
    data: JSON.stringify({ version: 3, date, savedAt: new Date().toISOString(), images, mealNotes, mealAnalysisCache, result }),
  });
}

async function deleteStoredHistoryRecord(date) {
  if (Capacitor.isNativePlatform()) {
    await deleteDeviceHistoryRecord({ filesystem: Filesystem, directory: Directory.Data, date });
  } else if (STATIC_HOSTED_WEB) {
    await deleteStaticHistoryRecord(date);
  } else {
    const response = await apiFetch(`/api/history/${encodeURIComponent(date)}`, { method: "DELETE" });
    const payload = await parseResponse(response);
    if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `刪除空白紀錄失敗（HTTP ${response.status}）。`);
  }
  await deleteGeneratedReport(date);
  state.historyDates.delete(date);
  updateHistoryCount();
}

function createCurrentHistorySnapshot(result = state.result) {
  return {
    date: state.activeDate,
    images: state.photos.map(photo => {
      if (typeof photo.dataBase64 !== "string" || !photo.dataBase64) {
        throw new Error(`${photo.name} 的圖片資料尚未準備完成。`);
      }
      return {
        name: photo.uploadName,
        mimeType: photo.mimeType,
        dataBase64: photo.dataBase64,
        note: "",
        mealType: photo.mealType,
        analysisFingerprint: photo.analysisFingerprint || "",
        cachedAnalysis: photo.cachedAnalysis || null,
      };
    }),
    mealNotes: Object.fromEntries(MEALS.map(meal => [meal.id, (state.mealNotes[meal.id] || "").trim()])),
    mealAnalysisCache: { ...state.mealAnalysisCache },
    result: result || null,
  };
}

async function persistHistorySnapshot(snapshot) {
  const hasNotes = Object.values(snapshot.mealNotes).some(note => note.trim());
  if (snapshot.images.length === 0 && !hasNotes) {
    await deleteStoredHistoryRecord(snapshot.date);
    return;
  }
  if (Capacitor.isNativePlatform()) {
    await saveNativeHistoryRecord(snapshot.date, snapshot.images, snapshot.mealNotes, snapshot.mealAnalysisCache, snapshot.result);
  } else if (STATIC_HOSTED_WEB) {
    await saveStaticHistoryRecord({
      version: 3,
      date: snapshot.date,
      savedAt: new Date().toISOString(),
      images: snapshot.images,
      mealNotes: snapshot.mealNotes,
      mealAnalysisCache: snapshot.mealAnalysisCache,
      result: snapshot.result,
    });
  } else {
    const response = await apiFetch(`/api/history/${encodeURIComponent(snapshot.date)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: snapshot.date,
        images: snapshot.images.map(({ name, mimeType, dataBase64, note, mealType }) => ({ name, mimeType, dataBase64, note, mealType })),
        mealNotes: snapshot.mealNotes,
        result: snapshot.result,
      }),
    });
    const payload = await parseResponse(response);
    if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `自動儲存失敗（HTTP ${response.status}）。`);
  }
  state.historyDates.add(snapshot.date);
  updateHistoryCount();
}

function queueCurrentHistorySave(result = state.result) {
  const snapshot = createCurrentHistorySnapshot(result);
  const save = historySaveQueue.catch(() => {}).then(() => persistHistorySnapshot(snapshot));
  historySaveQueue = save;
  return save;
}

async function listNativeHistoryDates() {
  return listDeviceHistoryDates({ filesystem: Filesystem, directory: Directory.Data });
}

async function readNativeHistoryRecord(date) {
  const stored = await Filesystem.readFile({
    path: `history/${date}.json`,
    directory: Directory.Data,
    encoding: Encoding.UTF8,
  });
  return JSON.parse(String(stored.data));
}

async function refreshHistoryDates() {
  if (Capacitor.isNativePlatform()) {
    state.historyDates = new Set(await listNativeHistoryDates());
    updateHistoryCount();
    return;
  }
  if (STATIC_HOSTED_WEB) {
    state.historyDates = new Set(await listStaticHistoryDates());
    updateHistoryCount();
    return;
  }
  const response = await apiFetch("/api/history", { headers: { Accept: "application/json" } });
  const payload = await parseResponse(response);
  if (!response.ok || !Array.isArray(payload?.dates)) {
    throw new Error(typeof payload?.error === "string" ? payload.error : "無法讀取歷史紀錄日期。");
  }
  state.historyDates = new Set(payload.dates.filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)));
  updateHistoryCount();
}

function downloadBrowserBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function exportStaticHistoryBackup() {
  if (!STATIC_HOSTED_WEB || state.busy) return;
  dom.exportHistoryBackup.disabled = true;
  dom.staticStorageStatus.textContent = "正在整理歷史紀錄…";
  try {
    await historySaveQueue.catch(() => {});
    const backup = createStaticBackup(await listStaticHistoryRecords());
    const blob = new Blob([JSON.stringify(backup, null, 2) + "\n"], { type: "application/json" });
    downloadBrowserBlob(blob, `餐盤小幫手-歷史備份-${localDateKey()}.json`);
    dom.staticStorageStatus.textContent = `已匯出 ${backup.records.length} 天紀錄；備份不包含 API key 與報告圖片。`;
  } catch (error) {
    dom.staticStorageStatus.textContent = error?.message || "無法匯出歷史備份。";
  } finally {
    dom.exportHistoryBackup.disabled = false;
  }
}

async function importStaticHistoryFile(file) {
  if (!STATIC_HOSTED_WEB || !file || state.busy) return;
  dom.importHistoryBackup.disabled = true;
  dom.staticStorageStatus.textContent = "正在驗證並匯入備份…";
  try {
    if (file.size > 200_000_000) throw new Error("備份檔超過 200 MB，請確認選擇了正確檔案。");
    const value = JSON.parse(await file.text());
    const count = await importStaticBackup(value);
    await refreshHistoryDates();
    renderHistoryCalendar();
    dom.staticStorageStatus.textContent = `已匯入 ${count} 天紀錄；相同日期已由備份內容更新。`;
  } catch (error) {
    dom.staticStorageStatus.textContent = error instanceof SyntaxError ? "備份檔不是有效的 JSON。" : (error?.message || "無法匯入歷史備份。");
  } finally {
    dom.historyBackupInput.value = "";
    dom.importHistoryBackup.disabled = false;
  }
}

function registerStaticServiceWorker() {
  if (!STATIC_HOSTED_WEB || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(new URL("./service-worker.js", window.location.href)).catch(() => {
      // The site still works online when service-worker registration is unavailable.
    });
  }, { once: true });
}

function renderHistoryCalendar() {
  const year = state.calendarCursor.getFullYear();
  const month = state.calendarCursor.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const today = localDateKey();
  dom.calendarMonthLabel.textContent = new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "long" }).format(state.calendarCursor);
  dom.calendarGrid.replaceChildren();

  for (let index = 0; index < firstWeekday; index += 1) {
    const blank = makeElement("span", "calendar-day calendar-blank");
    blank.setAttribute("aria-hidden", "true");
    dom.calendarGrid.append(blank);
  }
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const hasRecord = state.historyDates.has(date);
    const cell = makeElement("button", `calendar-day${hasRecord ? " has-record" : ""}`, day);
    cell.type = "button";
    if (date === today) cell.classList.add("is-today");
    if (date === state.activeDate) cell.classList.add("is-active");
    cell.setAttribute("aria-label", `${hasRecord ? "載入" : "新增"} ${formatRecordDate(date)} 的紀錄`);
    cell.addEventListener("click", () => selectCalendarDate(date));
    dom.calendarGrid.append(cell);
  }
  const count = [...state.historyDates].filter(date => date.startsWith(`${year}-${String(month + 1).padStart(2, "0")}-`)).length;
  dom.calendarStatus.textContent = count
    ? `本月有 ${count} 天既有紀錄。點選任一日期可查看，或在空白日期新增資料。`
    : "本月尚無紀錄；點選任一日期即可開始新增照片與備註。";
}

function selectCalendarDate(date) {
  scrollToPageTop();
  if (state.historyDates.has(date)) loadHistoryRecord(date);
  else startBlankDate(date);
}

function closeHistoryDialog() {
  if (typeof dom.historyDialog.close === "function" && dom.historyDialog.open) dom.historyDialog.close();
  else dom.historyDialog.removeAttribute("open");
}

async function openHistoryDialog() {
  closeSettingsDialog();
  const active = dateFromKey(state.activeDate);
  state.calendarCursor = new Date(active.getFullYear(), active.getMonth(), 1);
  dom.calendarStatus.textContent = "正在讀取歷史紀錄…";
  dom.calendarGrid.replaceChildren();
  if (typeof dom.historyDialog.showModal === "function") dom.historyDialog.showModal();
  else dom.historyDialog.setAttribute("open", "");
  try {
    await refreshHistoryDates();
    renderHistoryCalendar();
  } catch (error) {
    dom.calendarStatus.textContent = error?.message || "無法讀取歷史紀錄。";
  }
}

function base64ToBlob(dataBase64, mimeType) {
  const binary = atob(dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}

async function loadHistoryRecord(date) {
  closeHistoryDialog();
  clearError();
  setBusy(true);
  setProgress("正在載入歷史紀錄", formatRecordDate(date));
  let pendingPhotos = [];
  try {
    let record;
    if (Capacitor.isNativePlatform()) {
      record = await readNativeHistoryRecord(date);
    } else if (STATIC_HOSTED_WEB) {
      record = await readStaticHistoryRecord(date);
      if (!record) throw new Error("找不到這一天的歷史紀錄。");
    } else {
      const response = await apiFetch(`/api/history/${encodeURIComponent(date)}`, { headers: { Accept: "application/json" } });
      record = await parseResponse(response);
      if (!response.ok) throw new Error(typeof record?.error === "string" ? record.error : "無法載入這一天的紀錄。");
    }
    if (!record || record.date !== date || !Array.isArray(record.images) || !Object.hasOwn(record, "result")) {
      throw new Error("歷史紀錄內容不完整，無法載入。");
    }
    const loadedMealNotes = emptyMealNotes();
    if (record.mealNotes && typeof record.mealNotes === "object" && !Array.isArray(record.mealNotes)) {
      for (const meal of MEALS) {
        if (typeof record.mealNotes[meal.id] === "string") loadedMealNotes[meal.id] = record.mealNotes[meal.id].slice(0, NOTE_MAX_LENGTH);
      }
    } else {
      for (const meal of MEALS) {
        const legacyNotes = record.images
          .filter(image => image?.mealType === meal.id && typeof image.note === "string" && image.note.trim())
          .map(image => image.note.trim());
        loadedMealNotes[meal.id] = [...new Set(legacyNotes)].join("\n").slice(0, NOTE_MAX_LENGTH);
      }
    }
    if (record.images.length === 0 && !Object.values(loadedMealNotes).some(note => note.trim())) {
      await deleteStoredHistoryRecord(date);
      startBlankDate(date);
      return;
    }
    const storedResult = record.result === null ? null : validateResponse(record.result);
    pendingPhotos = record.images.map((image, index) => {
      if (!image || typeof image.name !== "string" || !SERVER_IMAGE_TYPES.has(image.mimeType)
        || typeof image.dataBase64 !== "string" || !MEAL_MAP.has(image.mealType)) {
        throw new Error("歷史紀錄內含無效的照片資料。");
      }
      const resultPhoto = storedResult?.photos?.find(photo => photo.name === image.name && photo.mealType === image.mealType)
        || storedResult?.photos?.[index];
      const analysisFingerprint = typeof image.analysisFingerprint === "string" ? image.analysisFingerprint : "";
      const directlyStoredCache = image.cachedAnalysis?.analysis && typeof image.cachedAnalysis.model === "string"
        ? image.cachedAnalysis
        : null;
      const cachedAnalysis = analysisFingerprint
        ? directlyStoredCache || (resultPhoto?.analysis && typeof resultPhoto.model === "string"
          ? { analysis: resultPhoto.analysis, model: resultPhoto.model }
          : null)
        : null;
      const blob = base64ToBlob(image.dataBase64, image.mimeType);
      return {
        id: uniqueId(),
        mealType: image.mealType,
        name: image.name,
        uploadName: safeUploadName(image.name),
        blob,
        mimeType: image.mimeType,
        previewUrl: URL.createObjectURL(blob),
        optimized: false,
        fallbackReason: "歷史紀錄",
        dataBase64: image.dataBase64,
        analysisFingerprint,
        cachedAnalysis,
      };
    });
    releasePhotos();
    state.expandedPhotoMeals.clear();
    state.photos = pendingPhotos;
    state.mealNotes = loadedMealNotes;
    state.mealAnalysisCache = record.mealAnalysisCache && typeof record.mealAnalysisCache === "object"
      ? record.mealAnalysisCache
      : {};
    pendingPhotos = [];
    state.activeDate = date;
    state.historyDates.add(date);
    renderMealSections();
    if (storedResult) renderResults(storedResult, { scroll: false });
    else invalidateResult();
  } catch (error) {
    pendingPhotos.forEach(photo => URL.revokeObjectURL(photo.previewUrl));
    showError(error?.message || "載入歷史紀錄時發生錯誤。");
    dom.errorPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  } finally {
    setBusy(false);
    renderMealSections();
    requestAnimationFrame(() => scrollToPageTop());
  }
}

function startBlankDate(date) {
  closeItemDialog();
  closeSettingsDialog();
  closeHistoryDialog();
  releasePhotos();
  state.expandedPhotoMeals.clear();
  state.mealNotes = emptyMealNotes();
  state.mealAnalysisCache = {};
  state.activeDate = date;
  state.result = null;
  dom.cameraInput.value = "";
  dom.galleryInput.value = "";
  dom.results.hidden = true;
  resetTopSummary();
  clearError();
  renderMealSections();
  requestAnimationFrame(() => scrollToPageTop());
}

async function returnToToday() {
  const today = localDateKey();
  try {
    await refreshHistoryDates();
    if (state.historyDates.has(today)) {
      await loadHistoryRecord(today);
      return;
    }
  } catch {
    // A blank current-day editor is still useful when the history list is unavailable.
  }
  startBlankDate(today);
}

function mealMiniTotal(totals, key) {
  const nutrient = NUTRIENTS.find(item => item.key === key);
  const box = makeElement("div", "meal-result-total");
  box.append(makeElement("strong", "", formatNutrient(totals?.[key], nutrient)), makeElement("span", "", nutrient.label));
  return box;
}

function confidenceText(value) {
  return { high: "高信心", medium: "中信心", low: "低信心" }[value] || "信心未知";
}

function openItemDialog(meal, item) {
  dom.itemDialogMeal.textContent = `${meal.label} · ${confidenceText(item.confidence)}`;
  dom.itemDialogTitle.textContent = item.name || "未命名品項";
  dom.itemDialogContent.replaceChildren();
  const meta = makeElement("div", "dialog-item-meta");
  meta.append(
    makeElement("span", "", `估計可食重量 ${formatNumber(nutritionNumber(item.estimated_weight_g))} g`),
    makeElement("span", "", item.source_photo ? `來源：${item.source_photo}` : ""),
  );
  const grid = makeElement("div", "dialog-nutrient-grid");
  NUTRIENTS.forEach(nutrient => grid.append(makeNutrientAmount(nutrient, item[nutrient.key], "dialog-nutrient")));
  dom.itemDialogContent.append(meta, grid);
  if (Array.isArray(item.assumptions) && item.assumptions.length) {
    const assumptions = makeElement("div", "dialog-assumptions");
    assumptions.append(makeElement("strong", "", "估算假設"));
    const list = makeElement("ul");
    item.assumptions.forEach(text => list.append(makeElement("li", "", text)));
    assumptions.append(list);
    dom.itemDialogContent.append(assumptions);
  }
  if (typeof dom.itemDialog.showModal === "function") dom.itemDialog.showModal();
  else dom.itemDialog.setAttribute("open", "");
}

function resultSliceForMeal(result, meal) {
  const photos = (result?.photos || []).filter(photo => photo.mealType === meal.id);
  const photoModels = [...new Set(photos.map(photo => photo.model).filter(Boolean))];
  return {
    model: photoModels.length === 1 ? photoModels[0] : photoModels.length ? photoModels : result?.model,
    requestedModel: result?.requestedModel,
    photos,
    meals: [meal],
    totals: meal.totals || {},
    cache: { reused: 1, analyzed: 0 },
  };
}

function updateMealAnalysisProgress(mealLabel, event) {
  if (event.type === "analyzing") {
    setProgress(`正在重新計算${mealLabel}`, `${event.imageName}（${event.index + 1} / ${event.total}）`);
  } else if (event.type === "retry") {
    setProgress("Gemini 暫時無法回應，正在重試", `${mealLabel} · ${event.reason} · 第 ${event.nextAttempt} / ${event.maxAttempts} 次`);
  } else if (event.type === "fallback") {
    setProgress("正在改用備援模型", `${mealLabel} · ${event.nextModel}`);
  }
}

async function recalculateMeal(mealId) {
  if (state.busy || !state.result) return;
  const definition = MEAL_MAP.get(mealId);
  if (!definition) return;
  if (!state.connection.apiKey) {
    showError("請先從右上角選單填入自己的 Google AI Studio API key。");
    dom.errorPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const sourcePhotos = state.photos.filter(photo => photo.mealType === mealId);
  const mealNote = (state.mealNotes[mealId] || "").trim();
  if (!sourcePhotos.length && !mealNote) {
    showError(`${definition.label}目前沒有照片或備註，無法重新計算。`);
    return;
  }

  clearError();
  const previousResult = state.result;
  const native = Capacitor.isNativePlatform();
  const directGemini = native || STATIC_HOSTED_WEB;
  const controller = new AbortController();
  state.analysisController = controller;
  setBusy(true);
  setProgress(`正在準備重新計算${definition.label}`, "會保留其他餐次的計算結果");
  const timeout = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
  try {
    const mealImages = [];
    for (let index = 0; index < sourcePhotos.length; index += 1) {
      throwIfAnalysisAborted(controller.signal);
      const photo = sourcePhotos[index];
      const dataBase64 = photo.dataBase64 || await blobToBase64(photo.blob, controller.signal);
      photo.dataBase64 = dataBase64;
      mealImages.push({ name: photo.uploadName, mimeType: photo.mimeType, dataBase64, mealType: mealId });
    }

    let mealResult;
    if (directGemini) {
      mealResult = validateResponse(await analyzeImagesOnDevice({
        images: mealImages,
        mealType: mealId,
        mealNote,
        cachedMealAnalysis: null,
        force: true,
        splitItems: state.connection.splitItems !== false,
        apiKey: state.connection.apiKey,
        prompt: nutritionPrompt,
        signal: controller.signal,
        onProgress: event => updateMealAnalysisProgress(definition.label, event),
      }));
      state.mealAnalysisCache[mealId] = mealResult.mealCache;
      sourcePhotos.forEach(photo => {
        photo.analysisFingerprint = mealResult.mealCache?.fingerprint || "";
        photo.cachedAnalysis = mealResult.mealCache || null;
      });
    } else {
      const response = await apiFetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Nutrition-History": "device" },
        body: JSON.stringify({
          date: state.activeDate,
          images: mealImages,
          mealNotes: { [mealId]: mealNote },
          force: true,
          splitItems: state.connection.splitItems !== false,
        }),
        signal: controller.signal,
      });
      const payload = await parseResponse(response);
      if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `${definition.label}重新計算失敗（HTTP ${response.status}）。`);
      mealResult = validateResponse(payload);
    }

    throwIfAnalysisAborted(controller.signal);
    const preserved = (previousResult.meals || [])
      .filter(meal => meal.id !== mealId)
      .map(meal => resultSliceForMeal(previousResult, meal));
    const merged = validateResponse(mergeAnalysisResults([...preserved, mealResult], state.activeDate));
    renderResults(merged, { scroll: false });
    await deleteGeneratedReport(state.activeDate);
    await queueCurrentHistorySave(merged);
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === "user") clearError();
    else if (controller.signal.aborted && controller.signal.reason === "timeout") showError(`${definition.label}重新計算超過 10 分鐘，請確認網路後再試。`);
    else if (error?.name === "AbortError") showError(`${definition.label}重新計算已中斷。`);
    else if (!directGemini && error instanceof TypeError) showError("無法連上分析服務，請確認伺服器是否正在執行。");
    else if (STATIC_HOSTED_WEB && error instanceof TypeError) showError("瀏覽器無法直接連上 Gemini，請確認網路、API key 與瀏覽器連線限制。");
    else showError(error?.message || `${definition.label}重新計算失敗，請稍後再試。`);
    if (!dom.errorPanel.hidden) dom.errorPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  } finally {
    clearTimeout(timeout);
    if (state.analysisController === controller) state.analysisController = null;
    setBusy(false);
    renderMealSections();
  }
}

function makeMealResult(meal, { embedded = false } = {}) {
  const section = makeElement("article", `meal-result-card meal-result-${meal.id}${embedded ? " meal-result-embedded" : ""}`);
  if (embedded) section.id = `meal-analysis-${meal.id}`;
  const header = makeElement("div", "meal-result-header");
  const identity = makeElement("div", "meal-identity");
  const definition = MEAL_MAP.get(meal.id) || { label: meal.label, icon: "•" };
  const copy = makeElement("div");
  const sourceSummary = meal.photoCount ? `${meal.photoCount} 張照片` : "純文字備註";
  copy.append(
    makeElement(embedded ? "h4" : "h3", "", embedded ? "營養分析" : (meal.label || definition.label)),
    makeElement("p", "", `${sourceSummary} · ${meal.items.length} 個品項`),
  );
  if (!embedded) {
    const icon = makeElement("span", "meal-icon", definition.icon);
    icon.setAttribute("aria-hidden", "true");
    identity.append(icon);
  }
  identity.append(copy);
  const calories = makeElement("div", "meal-result-calories");
  calories.append(makeElement("strong", "", formatNumber(meal.totals?.calories_kcal)), makeElement("span", "", "kcal"));
  const side = makeElement("div", "meal-result-side");
  const recalculateButton = makeElement("button", "meal-recalculate-button", "重新計算");
  recalculateButton.type = "button";
  recalculateButton.disabled = state.busy;
  recalculateButton.setAttribute("aria-label", `重新計算${meal.label || definition.label}營養`);
  recalculateButton.addEventListener("click", () => recalculateMeal(meal.id));
  side.append(calories, recalculateButton);
  header.append(identity, side);
  const totals = makeElement("div", "meal-result-totals");
  totals.append(
    mealMiniTotal(meal.totals, "protein_g"),
    mealMiniTotal(meal.totals, "fat_g"),
    mealMiniTotal(meal.totals, "carbs_g"),
    mealMiniTotal(meal.totals, "fiber_g"),
    mealMiniTotal(meal.totals, "sodium_mg"),
  );
  const itemDetails = makeElement("details", "meal-items");
  const itemHeading = makeElement("summary", "meal-items-heading");
  itemHeading.append(
    makeElement("strong", "", "營養品項"),
    makeElement("span", "", `${meal.items.length} 個品項 · 點擊展開`),
  );
  const items = makeElement("div", "meal-item-list");
  for (const item of meal.items) {
    const button = makeElement("button", "meal-item-button");
    button.type = "button";
    const itemCopy = makeElement("span", "meal-item-copy");
    itemCopy.append(makeElement("strong", "", item.name || "未命名品項"), makeElement("small", "", item.source_photo || "照片估算"));
    const itemAmount = makeElement("span", "meal-item-amount");
    itemAmount.append(makeElement("strong", "", `${formatNumber(item.calories_kcal)} kcal`), makeElement("small", "", `蛋白質 ${formatNumber(item.protein_g)} g`));
    button.append(itemCopy, itemAmount, makeSvg("m9 18 6-6-6-6"));
    button.addEventListener("click", () => openItemDialog(meal, item));
    items.append(button);
  }
  itemDetails.append(itemHeading, items);
  section.append(header, totals, itemDetails);
  if (Array.isArray(meal.uncertainty_notes) && meal.uncertainty_notes.length) {
    const details = makeElement("details", "meal-uncertainty");
    details.append(makeElement("summary", "", "查看這一餐的估算限制"));
    const list = makeElement("ul");
    meal.uncertainty_notes.forEach(entry => list.append(makeElement("li", "", entry.note || entry)));
    details.append(list);
    section.append(details);
  }
  return section;
}

function renderResults(payload, { scroll = true } = {}) {
  state.result = payload;
  if (typeof payload.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(payload.date)) {
    state.activeDate = payload.date;
    state.historyDates.add(payload.date);
    updateHistoryCount();
  }
  const meals = Array.isArray(payload.meals) ? payload.meals : [];
  const totals = payload.totals && typeof payload.totals === "object" ? payload.totals : {};
  const photos = Array.isArray(payload.photos) ? payload.photos : [];
  const reused = Number.isInteger(payload.cache?.reused) ? payload.cache.reused : 0;
  const analyzed = Number.isInteger(payload.cache?.analyzed) ? payload.cache.analyzed : photos.length;
  const cacheSummary = reused > 0 ? `；沿用 ${reused} 餐，只重新分析 ${analyzed} 餐` : `；新分析 ${analyzed} 餐`;
  dom.resultsSummary.textContent = `已整理 ${meals.length} 個餐次、${photos.length} 張照片${cacheSummary}`;
  dom.dailyHeadingDate.textContent = formatRecordDate(state.activeDate);
  renderTopSummary(totals);
  dom.resultPhotoCount.textContent = `${photos.length} 張`;
  dom.mealResults.replaceChildren();
  renderMealSections();
  dom.totalCalories.textContent = formatNumber(totals.calories_kcal);
  const model = typeof payload.model === "string" ? payload.model : Array.isArray(payload.model) ? payload.model.filter(value => typeof value === "string").join("、") : "";
  const requested = typeof payload.requestedModel === "string" ? payload.requestedModel : "";
  dom.modelLabel.textContent = model ? (requested && requested !== model ? `備援模型 ${model}` : `模型 ${model}`) : "AI 估算";
  dom.nutrientGrid.replaceChildren();
  NUTRIENTS.slice(1).forEach(nutrient => appendNutrientCard(nutrient, totals[nutrient.key]));
  dom.results.hidden = false;
  if (scroll) {
    requestAnimationFrame(() => {
      const target = document.querySelector(`#meal-analysis-${meals.at(-1)?.id}`) || dom.results;
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
}

async function parseResponse(response) {
  try { return await response.json(); }
  catch { throw new Error(response.ok ? "伺服器回傳的資料無法讀取。" : `伺服器發生錯誤（HTTP ${response.status}）。`); }
}

function validateResponse(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.photos) || !Array.isArray(payload.meals)
    || !payload.totals || typeof payload.totals !== "object") {
    throw new Error("伺服器回傳的分餐營養資料不完整，請重新計算。");
  }
  const normalizeNutrients = target => {
    if (!target || typeof target !== "object") return;
    for (const nutrient of NUTRIENTS) target[nutrient.key] = nutritionNumber(target[nutrient.key]);
  };
  const normalizeItem = item => {
    if (!item || typeof item !== "object") return;
    item.estimated_weight_g = nutritionNumber(item.estimated_weight_g);
    normalizeNutrients(item);
  };
  normalizeNutrients(payload.totals);
  for (const meal of payload.meals) {
    normalizeNutrients(meal?.totals);
    if (Array.isArray(meal?.items)) meal.items.forEach(normalizeItem);
  }
  for (const photo of payload.photos) {
    normalizeNutrients(photo?.totals);
    if (Array.isArray(photo?.analysis?.items)) photo.analysis.items.forEach(normalizeItem);
  }
  return payload;
}

function throwIfAnalysisAborted(signal) {
  if (!signal.aborted) return;
  throw new DOMException("營養分析已由使用者中止。", "AbortError");
}

function cancelAnalysis() {
  const controller = state.analysisController;
  if (!controller || controller.signal.aborted) return;
  setProgress("正在停止處理", "正在停止目前步驟與後續重試…");
  dom.calculateButton.disabled = true;
  dom.calculateButton.querySelector("span").textContent = "正在停止…";
  controller.abort("user");
}

function handleCalculateButton() {
  if (state.analysisController) {
    cancelAnalysis();
    return;
  }
  analyzePhotos();
}

async function analyzePhotos() {
  if (state.busy) return;
  if (!hasMealContent()) { showError("請先在至少一個餐次加入食物照片或備註。"); return; }
  if (!state.connection.apiKey) {
    showError("請先從右上角選單填入自己的 Google AI Studio API key。");
    dom.errorPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  clearError();
  state.expandedPhotoMeals.clear();
  invalidateResult();
  const native = Capacitor.isNativePlatform();
  const directGemini = native || STATIC_HOSTED_WEB;
  const controller = new AbortController();
  state.analysisController = controller;
  setBusy(true);
  const timeout = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
  try {
    const entries = [];
    for (let index = 0; index < state.photos.length; index += 1) {
      throwIfAnalysisAborted(controller.signal);
      const photo = state.photos[index];
      setProgress("正在整理今日照片與備註", `準備第 ${index + 1} / ${state.photos.length} 張：${MEAL_MAP.get(photo.mealType).label}`);
      const dataBase64 = photo.dataBase64 || await blobToBase64(photo.blob, controller.signal);
      photo.dataBase64 = dataBase64;
      throwIfAnalysisAborted(controller.signal);
      entries.push({ photo, image: {
        name: photo.uploadName,
        mimeType: photo.mimeType,
        dataBase64,
        mealType: photo.mealType,
      } });
    }
    const mealGroups = MEALS.map(meal => ({
      meal,
      entries: entries.filter(entry => entry.image.mealType === meal.id),
      note: (state.mealNotes[meal.id] || "").trim(),
    })).filter(group => group.entries.length > 0 || group.note);
    const completedResults = [];
    for (let mealIndex = 0; mealIndex < mealGroups.length; mealIndex += 1) {
      throwIfAnalysisAborted(controller.signal);
      const group = mealGroups[mealIndex];
      const mealImages = group.entries.map(entry => entry.image);
      setProgress(`正在計算${group.meal.label}熱量`, `第 ${mealIndex + 1} / ${mealGroups.length} 餐；完成後會立即顯示`);
      let mealResult;
      if (directGemini) {
        mealResult = validateResponse(await analyzeImagesOnDevice({
          images: mealImages,
          mealType: group.meal.id,
          mealNote: group.note,
          cachedMealAnalysis: state.mealAnalysisCache[group.meal.id] || null,
          splitItems: state.connection.splitItems !== false,
          apiKey: state.connection.apiKey,
          prompt: nutritionPrompt,
          signal: controller.signal,
          onProgress(event) {
            if (event.type === "analyzing") {
              setProgress(`正在使用 Gemini 計算${group.meal.label}`, `${event.imageName}（${event.index + 1} / ${event.total}）`);
            } else if (event.type === "reused") {
              setProgress(`正在整理${group.meal.label}`, `${event.imageName} 未變更，沿用先前結果`);
            } else if (event.type === "retry") {
              setProgress("Gemini 暫時無法回應，正在重試", `${group.meal.label} · ${event.imageName} · ${event.reason} · 第 ${event.nextAttempt} / ${event.maxAttempts} 次`);
            } else if (event.type === "fallback") {
              setProgress("正在改用備援模型", `${group.meal.label} · ${event.imageName} · ${event.nextModel}`);
            }
          },
        }));
        state.mealAnalysisCache[group.meal.id] = mealResult.mealCache;
      } else {
        const serverImages = mealImages.map(({ name, mimeType, dataBase64, mealType }) => ({ name, mimeType, dataBase64, mealType }));
        const response = await apiFetch("/api/analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Nutrition-History": "device" },
          body: JSON.stringify({
            date: state.activeDate,
            images: serverImages,
            mealNotes: { [group.meal.id]: group.note },
            splitItems: state.connection.splitItems !== false,
          }),
          signal: controller.signal,
        });
        const payload = await parseResponse(response);
        if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : `${group.meal.label}分析失敗（HTTP ${response.status}）。`);
        mealResult = validateResponse(payload);
      }
      throwIfAnalysisAborted(controller.signal);
      completedResults.push(mealResult);
      const result = validateResponse(mergeAnalysisResults(completedResults, state.activeDate));
      renderResults(result, { scroll: mealIndex === mealGroups.length - 1 });
      setProgress(`${group.meal.label}計算完成`, `已顯示結果並自動儲存；接著處理下一餐`);
      await queueCurrentHistorySave(result);
    }
  } catch (error) {
    if (controller.signal.aborted && controller.signal.reason === "user") {
      clearError();
    } else if (controller.signal.aborted && controller.signal.reason === "timeout") {
      showError("分析等候超過 10 分鐘，請確認網路後再試。");
    } else if (error?.name === "AbortError") {
      showError("分析已中斷，請確認網路後再試。");
    }
    else if (!directGemini && error instanceof TypeError) showError("無法連上分析服務，請確認伺服器是否正在執行。");
    else if (STATIC_HOSTED_WEB && error instanceof TypeError) showError("瀏覽器無法直接連上 Gemini，請確認網路、API key 與瀏覽器連線限制。");
    else showError(error?.message || "分析時發生未預期錯誤，請稍後再試。");
    if (!dom.errorPanel.hidden) dom.errorPanel.scrollIntoView({ behavior: "smooth", block: "center" });
  } finally {
    clearTimeout(timeout);
    if (state.analysisController === controller) state.analysisController = null;
    setBusy(false);
    renderMealSections();
  }
}

function closeItemDialog() {
  if (typeof dom.itemDialog.close === "function" && dom.itemDialog.open) dom.itemDialog.close();
  else dom.itemDialog.removeAttribute("open");
}

function scrollToPageTop(smooth = false) {
  window.scrollTo({ top: 0, left: 0, behavior: smooth ? "smooth" : "auto" });
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
}

dom.cameraInput.addEventListener("change", event => addFiles(event.currentTarget.files));
dom.galleryInput.addEventListener("change", event => addFiles(event.currentTarget.files));
dom.calculateButton.addEventListener("click", handleCalculateButton);
dom.exportImageButton.addEventListener("click", openExportDialog);
dom.exportDialogClose.addEventListener("click", closeExportDialog);
dom.exportDialog.addEventListener("click", event => { if (event.target === dom.exportDialog) closeExportDialog(); });
dom.previewSavedReportButton.addEventListener("click", previewSavedReport);
dom.saveGalleryButton.addEventListener("click", () => exportPageImage(Capacitor.isNativePlatform() ? "gallery" : "download"));
dom.shareExportButton.addEventListener("click", () => exportPageImage("share"));
dom.longExportButton.addEventListener("click", () => exportPageImage(Capacitor.isNativePlatform() ? "gallery" : "download", "full"));
dom.newAnalysisButton.addEventListener("click", returnToToday);
dom.backToTopButton.addEventListener("click", () => scrollToPageTop(true));
dom.itemDialogClose.addEventListener("click", closeItemDialog);
dom.itemDialog.addEventListener("click", event => { if (event.target === dom.itemDialog) closeItemDialog(); });
dom.photoViewerClose.addEventListener("click", closePhotoViewer);
dom.photoViewerDialog.addEventListener("cancel", event => { event.preventDefault(); closePhotoViewer(); });
dom.photoViewerZoomOut.addEventListener("click", () => updatePhotoViewerZoom(photoViewerZoom - 0.5));
dom.photoViewerZoomReset.addEventListener("click", resetPhotoViewerZoom);
dom.photoViewerZoomIn.addEventListener("click", () => updatePhotoViewerZoom(photoViewerZoom + 0.5));
dom.photoViewerStage.addEventListener("touchstart", beginPhotoViewerGesture, { passive: false });
dom.photoViewerStage.addEventListener("touchmove", movePhotoViewerGesture, { passive: false });
dom.photoViewerStage.addEventListener("touchend", event => {
  if (event.touches.length) beginPhotoViewerGesture(event);
  else photoViewerGesture = null;
}, { passive: false });
dom.photoViewerStage.addEventListener("touchcancel", () => { photoViewerGesture = null; });
dom.photoViewerImage.addEventListener("load", () => requestAnimationFrame(resetPhotoViewerZoom));
dom.exportCompleteLater.addEventListener("click", dismissExportCompleteDialog);
dom.exportCompleteOpen.addEventListener("click", openGeneratedImage);
dom.exportCompleteDialog.addEventListener("click", event => {
  if (event.target === dom.exportCompleteDialog) dismissExportCompleteDialog();
});
dom.exportCompleteDialog.addEventListener("cancel", event => { event.preventDefault(); dismissExportCompleteDialog(); });
dom.nutritionMenuButton.addEventListener("click", openSettingsDialog);
dom.nutritionSettingsClose.addEventListener("click", closeSettingsDialog);
dom.nutritionSettingsForm.addEventListener("submit", saveNutritionTargets);
dom.nutritionSettingsClear.addEventListener("click", clearNutritionTargets);
dom.toggleApiKey.addEventListener("click", toggleApiKeyVisibility);
dom.splitFoodItems.addEventListener("change", updateSplitItemsSetting);
dom.openApiKeyGuide.addEventListener("click", openApiKeyGuide);
dom.apiKeyGuideClose.addEventListener("click", closeApiKeyGuide);
dom.apiKeyGuideDialog.addEventListener("click", event => {
  if (event.target === dom.apiKeyGuideDialog) closeApiKeyGuide();
});
dom.apiKeyGuideDialog.addEventListener("cancel", event => {
  event.preventDefault();
  closeApiKeyGuide();
});
dom.nutritionSettingsDialog.addEventListener("click", event => {
  if (event.target === dom.nutritionSettingsDialog) closeSettingsDialog();
});
dom.openHistoryButton.addEventListener("click", openHistoryDialog);
dom.historyDialogClose.addEventListener("click", closeHistoryDialog);
dom.historyDialog.addEventListener("click", event => { if (event.target === dom.historyDialog) closeHistoryDialog(); });
dom.calendarPrevious.addEventListener("click", () => {
  state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() - 1, 1);
  renderHistoryCalendar();
});
dom.calendarNext.addEventListener("click", () => {
  state.calendarCursor = new Date(state.calendarCursor.getFullYear(), state.calendarCursor.getMonth() + 1, 1);
  renderHistoryCalendar();
});
dom.returnTodayButton.addEventListener("click", returnToToday);
dom.exportHistoryBackup.addEventListener("click", exportStaticHistoryBackup);
dom.importHistoryBackup.addEventListener("click", () => dom.historyBackupInput.click());
dom.historyBackupInput.addEventListener("change", event => importStaticHistoryFile(event.currentTarget.files?.[0]));
window.addEventListener("beforeunload", () => {
  state.photos.forEach(photo => URL.revokeObjectURL(photo.previewUrl));
  if (activePhotoPreviewUrl) URL.revokeObjectURL(activePhotoPreviewUrl);
});

async function initializeApp() {
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  scrollToPageTop();
  dom.splitFoodItems.checked = state.connection.splitItems !== false;
  dom.staticWebData.hidden = !STATIC_HOSTED_WEB;
  registerStaticServiceWorker();
  renderMealSections();
  updateConnectionStatus();

  const today = localDateKey();
  setBusy(true);
  setProgress("正在載入今日紀錄", formatRecordDate(today));
  try {
    await refreshHistoryDates();
    if (state.historyDates.has(today)) {
      await loadHistoryRecord(today);
      return;
    }
  } catch (error) {
    showError(error?.message || "無法載入今日紀錄。");
  }

  setBusy(false);
  renderMealSections();
  requestAnimationFrame(() => scrollToPageTop());
}

initializeApp();
