# Calories Guard 專案記憶

最後更新：2026-09-24

## 專案目標

這是一個以繁體中文為主、手機優先的每日飲食紀錄工具。使用者可按早餐、午餐、下午茶、晚餐、宵夜加入照片與整餐共用備註，呼叫 Google Gemini 估算食物細項、份量、熱量與營養成分，保存每日歷史紀錄並匯出適合手機閱讀及分享的全天報告。

專案根目錄為 `D:\codex-project\carories-guard-app2`。目前同時包含：

- Node.js 命令列分析工具。
- 由 Node.js 提供靜態檔案與 API 的本機網頁版。
- Capacitor Android App，可完全在手機上直接呼叫 Gemini，不需要 Node.js 後端。
- 已建立的 Capacitor iOS 專案；Windows 無法輸出可安裝的 IPA，須移到 macOS 由 Xcode 簽章與建置。

## 使用者已確認的產品需求

- 五個餐次為早餐、午餐、下午茶、晚餐、宵夜。
- 每餐最多 10 張照片，每天最多 30 張。
- 每餐共用一份備註；沒有照片也能只用文字備註分析及保存。
- 照片區預設收合，新加入照片後才展開；營養分析固定顯示在照片區下方，不隨照片收合。
- 營養品項預設收合，展開後可點品項查看完整營養與估算假設。
- 各餐與全天都包含熱量、蛋白質、碳水化合物、脂肪、膳食纖維、糖與鈉；不得讓總計出現空值。
- 實物食物資料不足時要合理估算。包裝營養標示若缺少膳食纖維或糖等欄位，也要估算，不能直接因為標示缺項而填 0。
- 「拆分細項」預設開啟。例如魚排咖哩要拆成炸魚排、咖哩醬、飯、玉米筍、荷包蛋，而非只回傳一個整體品項。
- 同一餐的正面商品照與營養標示照要一起送 Gemini 判斷；若屬於同一品項，只計算一次。報告中只有在同品項已有一般照片或商品正面照時才略過營養標示照；若只有營養標示照，仍要放入報告。
- 頁首右側直接顯示總熱量大圓及蛋白質、碳水、脂肪小圓。填入每日建議值後，以圓餅進度顯示比例；超過 100% 的部分用紅色呈現。頁面底部保留完整全天總計。
- 可設定熱量及各營養建議值；底部和報告要顯示達成百分比及還可吃多少或超出多少。未填建議值時略過比較功能。
- 使用者自行填入 Google AI Studio API key。設定介面含「如何取得 API Key」教學、官方連結，以及會消耗使用者自身 token／額度的警告。key 只存本機設定，不得寫入 APK、bundle 或歷史 JSON。
- 「計算熱量」逐餐呼叫 Gemini，每餐完成即先顯示；處理中按鈕變成「暫停處理」，可中止目前請求、重試等待和後續餐次。
- 各餐有小型「重新計算」按鈕，可強制重算該餐。
- 相同照片、整餐備註、prompt、模型與拆分設定未改變時沿用快取，避免重複消耗 token。
- 加入／刪除照片或修改備註時立即自動保存，不等按下分析。
- 日曆可選任何日期。有紀錄時載入，無紀錄時開空白頁且可編輯。「回到今日」必須和日曆上方的今日按鈕走同一載入流程。
- 日期完全沒有照片且所有餐次備註皆空白時刪除 JSON 並移除日曆標記；只有備註時仍須保留。
- App 啟動時要載入今日已保存資料並停在頁面頂端；從日曆切換日期也回到頂端。
- Android 的拍照按鈕要開啟真正相機，相簿按鈕才是挑選既有照片。
- 縮圖可以裁切填滿卡片，但點擊後必須預覽完整原圖並支援合理的拖曳、縮放，且預覽工具不能遮住內容。
- 底部有移到頂部功能。
- 匯出按鈕文字為「匯出報告」。匯出完成可選擇立即開啟；Android 同時支援存入相簿及分享。
- 每個日期只保留一份最新報告，重新匯出覆蓋舊報告；若已有報告，匯出選單可直接預覽。
- 一般頁面底部保留完整營養總計；只有圖片報告移除重複的底部總計，報告頂端顯示一次完整全天營養。
- 從 2026-09-22 起，每次功能修改都要同步更新 `version.md`。

## 現行架構與關鍵檔案

- `public/app.js`：主要 UI、狀態、照片壓縮、餐次操作、自動保存、日曆、分析流程、停止處理、匯出及原生能力整合。請修改此檔，不要直接手改產物 `public/app.bundle.js`。
- `public/mobile-gemini.js`：Android／iOS 直接呼叫 Gemini 的請求組裝、結構化 schema、驗證、重試、模型備援、餐次指紋快取及結果合併。
- `public/report-export.js`：Canvas 全天報告、照片裁切與排列、營養總覽、JPEG 壓縮。
- `public/device-history.js`：Capacitor 裝置歷史資料夾列舉和刪除，已處理 Android `Directory already exists` 競態錯誤。
- `public/index.html`、`public/styles.css`：介面結構及手機排版。
- `server.mjs`：本機網頁 API、同源 Gemini 轉送、驗證、快取及伺服器端 `history/YYYY-MM-DD.json`。
- `analyze-nutrition.mjs`：讀取 `data` 圖片與配對文字檔的 CLI 工具。
- `prompt.txt`：共用營養分析要求。
- `plugins/gallery-saver`：Android 相簿儲存與覆蓋同名舊報告的自訂 Capacitor plugin。
- `android/`、`ios/`：Capacitor 原生專案。
- `test/`：離線測試，不使用真實 API key，也不呼叫 Gemini。
- `version.md`：依日期記錄所有使用者可見改動。
- `README.md`：安裝、API key、Web、Android、iOS 和 CLI 教學。部分報告演算法描述可能落後於近期調整；實作細節以 `public/report-export.js` 和本檔「現行報告排版」為準。

## Gemini 行為

- 手機端主模型：`gemini-3.1-flash-lite`。
- 手機端備援模型：`gemini-3.8-flash`。
- 暫時性錯誤包含 408、429、500、502、503、504；每個模型最多嘗試 6 次並使用退避等待。使用者中止後不得繼續重試。
- App 直接用 `x-goog-api-key` 呼叫 Google REST API；不需要後端網址。
- 本機 Web 將使用者 key 以 `X-Gemini-Api-Key` 傳給同源 Node server，再由 server 呼叫 Gemini。CLI 仍可從 `.env` 讀 key。
- 每餐獨立送出，最多 10 張；五餐依序處理並逐餐顯示。
- API key 不得出現在日誌、錯誤回應、分析結果、歷史 JSON、bundle 或 APK。
- 每餐快取依照片內容、整餐備註、prompt、模型及 `splitItems` 設定產生指紋。只有輸入變更或使用者按該餐「重新計算」才再次呼叫 Gemini。
- Gemini 回傳每張照片的 `role`、`subject_identity`、`visible_item_count`、`include_in_report` 和 `report_crop_box`，供去重和報告排版使用。

## 歷史資料與照片保存

- 網頁開發模式：`history/YYYY-MM-DD.json`，由 `server.mjs` 管理。
- Android／iOS：App 私有資料目錄中的 `history/YYYY-MM-DD.json`，由 Capacitor Filesystem 管理，不複製到 server。
- JSON 內的照片以 Base64 保存。這是編碼而非再次有損壓縮；但照片加入時會先在瀏覽器端縮至最長邊 1600 px、JPEG 品質約 0.84，因此相較原檔變小的主要原因是加入前預處理。
- 單張來源檔上限 14 MB；每日處理後照片總量上限 35 MB。伺服器 request body 上限 55 MB。手機單次 Gemini inline request 上限保守設為 19 MB。
- 每餐 10 張、每日 30 張的限制已在 UI、手機 Gemini 模組、server、README 與測試同步。
- 設定及 API key 使用本機儲存，不放進每日 JSON。

## 現行報告排版

目前採用「矩形餐卡 + 餐內照片二維排列 + 全天 Skyline／beam search」，這是使用者在比較多種方法後要求恢復並繼續調整的版本。

- 報告 logical width 為 1080 px；輸出固定短邊 1440 px，Canvas 等比放大繪製。
- 輸出為高品質 JPEG，逐級降低品質並以約 2 MB 以下為目標，讓 LINE 壓縮後仍較易閱讀。
- 頂端保留原本較好看的日期與「今日營養報告」視覺，並顯示一次完整全天營養及建議值比較。蛋白質／碳水／脂肪同一直排，其他三項另一直排。
- 報告每餐只顯示餐次、照片和所有品項名稱，不顯示每餐營養明細，也不使用「另有幾項」省略字樣。
- 照片使用 Gemini 裁切框去除多餘背景；只採用中／高信心且有效的框並加 12% 安全留白，低信心時保留完整照片。顯示時保持裁切後比例，不再把食物硬裁成固定格。
- 多品項照片以 `visible_item_count` 加權面積，`photoAreaWeight = min(3.25, 1 + 0.45 × (品項數 - 1))`；單品飲料／零食可更小，多品項主餐取得更大面積。
- 餐內每列允許 1～3 張。6 張以下會完整枚舉照片順序；7～10 張改用有限候選搜尋，包括循環位移，以及依長寬比、品項權重、加權寬高需求排序，避免 `10!` 階乘運算。
- 餐卡會產生多個寬度候選，再用 Skyline beam search 排整天。早餐、午餐、晚餐維持相對時間順序；下午茶和宵夜可以插入任何可用位置以填空，但同一餐內容必須相鄰。
- 空白面積懲罰權重目前為 0.55。多品項卡可接受更大的縮放彈性；相關門檻集中在 `buildMealVariants()`。
- 最後一餐後另留 footer 空間，已修正總營養遮住晚餐的問題。
- 最新 10 張照片的單次餐內排列基準測試約 34 ms，未出現階乘式卡頓。

### 已嘗試但已撤回的排版

不要把下列方案誤認為目前功能，也不要重新加入選擇器，除非使用者再次明確要求：

- 全局網格。
- Guillotine 切割。
- Polyomino／自由 L 型餐區。
- 同時讓使用者選多種報告演算法。

這些方法曾實作或製作樣本，但實際效果不符合使用者對「密、少空白、餐次相鄰、多品項照片較大」的要求，已撤回。現在只有上述矩形二維背包／Skyline 版本。

## GitHub Pages 靜態網站

- 已加入 `github.io` 專用的純靜態模式。瀏覽器直接使用 `public/mobile-gemini.js` 呼叫 Gemini；歷史紀錄和最近產生的報告保存在 IndexedDB，不使用 `server.mjs` 或 `/api`。
- 靜態站設定中可下載／匯入包含照片、備註、分析結果及餐次快取的 JSON 備份；備份不包含 API key 或報告圖片。相同日期匯入時會由備份覆蓋。
- 已加入 `.github/workflows/deploy-pages.yml`，推送 `main` 時會測試、bundle 並只發布 `public`；另有 PWA manifest 和離線 App shell。部署前仍須在 GitHub repository 的 Settings → Pages 將 Source 設為 GitHub Actions。
- 可用 `http://127.0.0.1:3000/?static=1` 測試靜態模式；一般本機網址不帶參數時仍使用 Node API。Android 原生平台完全沿用原本的 Capacitor Filesystem、GallerySaver 與直接 Gemini 分支。

## 尚未實作或受平台限制的方向
- iOS 原生專案已存在，但 Windows 不能產生正式 IPA。需要 macOS、Xcode、Apple Developer Team 與簽章。
- Android 目前輸出的是 debug APK，適合側載；上架 Google Play 需要 release keystore 與簽署 AAB。

## 開發與驗證流程

環境需求：Node.js 22+。PowerShell 建議使用 `npm.cmd`，避免執行原則阻擋 `npm.ps1`。

常用指令：

```powershell
npm.cmd test
npm.cmd run build:web
npm.cmd start
npm.cmd run android:apk
```

- 修改 `public/app.js` 或其匯入模組後，至少執行 `npm.cmd run build:web` 以更新 `public/app.bundle.js`。
- Android APK 指令會先 bundle Web、執行 `cap sync`，再用 Gradle 建置，最後覆蓋 `releases/calories-guard-debug.apk`。
- Android 建置需要 JDK 21、Android SDK Platform 36。`scripts/build-android.ps1` 會尋找 Android Studio JBR 或 `.test-tmp/jdk21`。
- 每次改動執行相應測試，並更新 `version.md`。涉及 Android 功能或前端交付時，重建 APK。

截至 2026-09-24 的最後驗證：

- `npm.cmd test`：86 項全部通過，包含靜態模式判斷及 JSON 備份格式測試。
- `npm.cmd run build:web`：成功。
- 上一版 `npm.cmd run android:apk`：成功；加入 GitHub Pages 後未執行 Capacitor sync 或重建 APK，因此既有 Android App 與 APK 未變動。
- APK：`releases/calories-guard-debug.apk`，8.44 MiB。
- APK SHA-256：`1324D7AD6C0BAED49DC593100603670958E5CE1FE583288B673BD880169F443D`。

## 下一個 session 的接手原則

1. 先讀本檔，再讀 `version.md` 最上方日期與相關原始碼；不要只依 README 推斷最新排版。
2. 保留使用者已確定的資料模型：每餐共用備註、可純文字、逐餐分析、餐次快取、空白日期刪除。
3. 報告排版修改時，維持早／午／晚相對順序、同餐相鄰、多品項照片較大、照片不失真、盡量少空白。
4. 7～10 張照片不可做完整 permutation；使用有限候選或其他有明確上界的搜尋。
5. Web 與 Android 都要同步。改完測試、重建 bundle；需要交付 App 時重建 APK。
6. 不讀出、顯示或提交 `.env` 的真實 API key。
7. 所有新功能或修正都追加到 `version.md`，包含日期與具體行為。
