# 用 Gemini 分析餐點照片的營養與熱量

`analyze-nutrition.mjs` 會讀取 `data` 資料夾的餐點照片，將圖片、共用文字 prompt，以及該圖片的文字註記一起送給 Gemini。每張照片獨立分析，輸出繁體中文報告與 JSON，包含食物份量、熱量、蛋白質、脂肪、碳水化合物、膳食纖維、糖與鈉，並由程式加總各項營養值。

命令列工具與本機網頁開發模式需要 **Node.js 22 以上版本**；已安裝的 Android／iOS App 本身不需要 Node.js 或後端。命令列工具只使用 Node.js 內建功能，不必安裝 Python。

預設優先使用 `gemini-3.1-flash-lite`。Google 官方將它列為支援圖片輸入及結構化輸出的穩定低延遲模型；模型清單可能更新，可以透過設定更換。[模型官方說明](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite)

## 使用手機排版 GUI

在 PowerShell 啟動本機網頁；GUI 的 API key 由使用者稍後在右上角選單填入，不必先寫進 `.env`：

```powershell
cd D:\codex-project\carories-guard-app2
npm.cmd start
```

接著用瀏覽器開啟：

```text
http://127.0.0.1:3000
```

頁面分成早餐、午餐、下午茶、晚餐與宵夜。每個餐次可直接拍照或從相簿加入最多 10 張照片，全天最多 30 張，並共用一份餐次備註；沒有拍照時也能只用文字描述餐點。按下「計算熱量」後，頁面會先顯示各餐的熱量、蛋白質、脂肪、碳水化合物、膳食纖維與鈉。各餐的辨識品項預設收合，展開後可點選品項查看該食物的完整營養資料與估算假設，最下方再顯示全天總計。

分析開始後，「計算熱量」會變成「暫停處理」。按下後會中止目前等待、後續重試與尚未分析的餐次，按鈕恢復後可再次計算。

頁首標題右側會用大圓形指標直接顯示今日總熱量，下方三個小圓分別顯示蛋白質、碳水化合物與脂肪的公克數，不必滑到頁面底部查看。照片或備註有變更時，舊數值會先清空，完成重新計算後再更新；其他完整營養數值仍顯示在頁面底部。

圖片報告的品項會保留餐次備註中的明確份量，例如備註「香蕉一條、白飯四分之一碗」時會顯示為「香蕉（一條）」、「白飯（四分之一碗）」。舊紀錄若還沒有逐品項的結構化份量，報告會從備註比對原有品項並把份量直接加在名稱後；無法明確對應的文字不會另外列成品項。

頁面最下方的「匯出圖片」預設把全天總計與所有餐次整理成一張寬度 `1080 px` 的手機報告。報告只在頂部顯示一次全天總營養，一般頁面底部的完整營養資訊則照常保留。每餐只顯示餐次、照片與品項名稱，不再重複熱量或各項營養小計；純文字餐次也會出現在報告。Gemini 會在原本的營養分析回傳中一併提供照片角色與建議裁切框；同一品項若同時有一般商品照與營養成分標示照，報告只放一般商品照並略過營養標示照。若該品項只有營養標示照，仍會保留它，避免餐點在報告中完全沒有照片。報告只對高或中信心的裁切框套用 `12%` 安全留白，低信心、無效座標及沒有裁切框的舊紀錄會顯示完整照片。每個餐次會先枚舉 `300–960 px` 的候選卡片寬度，餐內再依裁切後的照片長寬比搜尋每列 1～3 張的最佳組合；最後由受時間順序限制的 Skyline 拼排選擇餐卡尺寸與位置，讓單張直式照片使用窄欄，其他餐次利用旁邊或下方空間。照片保持相同顯示面積，版型會優先保留至少約 `220 px` 的照片短邊。每個日期只保存一份最近產生的全天報告；再次匯出會覆蓋舊檔，匯出選單也會提供「預覽已產生報告」。存到 Android 相簿時會更新同名圖片並移除同名舊副本。最後一餐與頁尾保留獨立間距。匯出完成後可立即打開完整圖片預覽。匯出選單仍保留原本由上到下的完整頁面長截圖。報告圖片在本機產生，匯出時不會再次呼叫 Gemini，原始照片也不會被修改或重新壓縮。

餐點編輯區的縮圖維持填滿卡片的顯示方式；點一下縮圖即可開啟未裁切的完整照片，並可在手機上以雙指縮放查看。

右上角選單可以設定個人的每日熱量、蛋白質、脂肪、碳水化合物、膳食纖維、糖與鈉建議值，設定只保存在目前瀏覽器。填寫後，頁首四個圓會以圓餅進度呈現攝取比例，底部各營養卡會顯示達成百分比與剩餘可攝取量；超過建議值時則顯示超出量。每個欄位都可獨立留白，沒有建議值的項目不顯示這些進度資訊。

同一個設定頁最上方有「Gemini 連線」。請貼上自己在 Google AI Studio 建立的 API key。Android／iOS App 會直接連線 Google Gemini API，不需要填寫後端網址或啟動 Node.js。key 只保存在目前瀏覽器或 App 的本機儲存空間，分析時才透過 `x-goog-api-key` 標頭送到 Google，不會寫入網頁 bundle、Android APK、iOS 專案或歷史 JSON。

右上角選單最上方有「日曆」。月曆上的每一天都可以點選：有顏色的日期代表已有紀錄，點選後會載入當天資料；沒有紀錄的日期會開啟空白編輯頁，仍可加入各餐照片與備註。加入照片、修改備註或完成分析時，都會更新以日期命名的 `YYYY-MM-DD.json`。網頁版將檔案保存在後端的 `history` 資料夾；Android／iOS App 則保存在裝置的 App 私有資料目錄，不在後端留下副本。內容包含照片 Base64、餐次共用備註與分析結果。只有當天完全沒有照片且所有餐次備註都為空白時才會刪除 JSON；只寫備註的日期仍會保留並顯示在日曆。`history` 已排除在 Git 追蹤之外；檔案包含餐點照片內容，備份或分享專案時請依個人隱私需求處理。

一般照片會先在瀏覽器縮至長邊 1600 px，減少上傳時間。GUI 的 API key 由使用者自行填入；手機 App 直接送至 Google，網頁開發模式則交給同源 Node.js 伺服器轉送。命令列模式仍可從 `.env` 讀取 key。同一餐的全部照片與共用備註會在一次請求內分析；若一般商品照與營養成分標示照屬於同一品項，Gemini 會合併辨識並只計算一次。

為了節省 Gemini token，再次按下計算時，某餐的全部照片、共用備註、模型和共用 prompt 都未改變，就會直接沿用該餐結果；只有新增或變更的餐次會再次呼叫 Gemini。手機 App 會把餐次分析指紋和結果存入當日 JSON，因此重新開啟 App 或從日曆載入日期後仍可沿用。

若要用同一個 Wi-Fi 上的手機開啟，改用以下方式啟動：

```powershell
$env:HOST = "0.0.0.0"
npm.cmd start
ipconfig
```

找到電腦的 IPv4 位址後，在手機開啟 `http://<電腦 IPv4>:3000`。第一次可能需要允許 Windows 防火牆存取；此模式只適合信任的區域網路。

## 安裝 Android App

已產生可直接側載測試的 debug APK：

```text
releases/calories-guard-debug.apk
```

把 APK 複製到 Android 手機並開啟，依系統提示允許從該來源安裝。這是以 Android debug 憑證簽署的測試版本，適合自己安裝；若要上架 Google Play，仍需建立自己的 release keystore 並輸出簽署的 AAB。

APK 已把 Gemini 請求組裝、回傳驗證、暫時性錯誤重試、備援模型、照片快取、營養加總與 JSON 歷史紀錄全部包進 App。安裝後只要連上網路，從右上角選單填入自己的 Google AI Studio API key，就能直接分析；不需要電腦、Node.js、後端網址或同一個 Wi-Fi。

Android App 的每日 JSON、照片、備註與營養結果保存在 App 的私有資料目錄，不會另外複製到後端的 `history` 資料夾。全天報告可存入相簿或直接分享，原本的完整頁面長截圖也保留在匯出選單。

修改前端後重新建立 APK：

```powershell
npm.cmd run android:apk
```

這個指令會先重新 bundle 網頁、同步 Capacitor，再編譯並更新 `releases/calories-guard-debug.apk`。建置電腦需要 JDK 21、Android SDK Platform 36 與 Build Tools；本機已使用 Google Android CLI 安裝 SDK。

## 免費部署到 GitHub Pages

GitHub Pages 版是純靜態網站，不需要 Node.js 伺服器。網址位於 `github.io` 時，網頁會自動改成直接呼叫 Gemini，並將每日歷史與最近產生的報告保存在該瀏覽器的 IndexedDB。Android App 的原生儲存與分析流程不受影響。

部署前可在本機測試靜態模式：

```powershell
npm.cmd start
```

開啟：

```text
http://127.0.0.1:3000/?static=1
```

不加 `?static=1` 時仍是原本使用 Node API 的本機網頁模式。

部署步驟：

1. 在 GitHub 建立一個公開 repository，例如 `calories-guard-web`，先不要勾選自動建立 README。
2. 確認專案的預設分支使用 `main`。專案已提供 `.github/workflows/deploy-pages.yml`，每次推送 `main` 都會自動測試、建立 `public/app.bundle.js`，並只把 `public` 資料夾發布到 Pages。
3. 在專案資料夾執行下列指令，將 `<你的帳號>` 和 `<repository 名稱>` 換成實際值：

```powershell
git init
git branch -M main
git add .
git commit -m "Deploy Calories Guard web app"
git remote add origin https://github.com/<你的帳號>/<repository名稱>.git
git push -u origin main
```

4. 進入 GitHub repository 的 **Settings → Pages**，在 **Build and deployment → Source** 選擇 **GitHub Actions**。
5. 到 **Actions** 頁面等待 `Deploy GitHub Pages` 完成。成功後可從 Pages 設定頁的 **Visit site** 開啟，網址通常是：

```text
https://<你的帳號>.github.io/<repository名稱>/
```

6. 第一次開啟後，從右上角設定填入使用者自己的 Google AI Studio API key。不要把 key 寫進 GitHub repository、workflow、`app.js` 或任何 GitHub Secret；此架構由每位使用者在自己的瀏覽器中輸入 key。

GitHub Pages 版的資料只存在目前瀏覽器與目前網站來源。清除網站資料、改用其他瀏覽器、換手機或更換 repository 網址，都不會自動帶入舊紀錄。設定中的「網站資料備份」可下載包含照片、備註、營養結果和快取的 JSON；在其他裝置選擇「匯入備份」即可還原。備份不包含 API key 或已產生的報告圖片。

上傳前請確認沒有強制加入 `.env`、`data`、`history`、`results` 或 `releases`。這些路徑已列入 `.gitignore`；若過去曾經提交真實 API key，僅加入忽略規則並不能從 Git 歷史移除，應立即撤銷該 key 並建立新 key。

## iOS 專案

Capacitor iOS 專案位於 `ios/App`，已包含相簿、相機、文件匯出與分享所需設定。因 Apple 的工具限制，Windows 無法產生可安裝的 `.ipa`。把專案移到 macOS 後執行：

```bash
npm install
npm run mobile:sync
npx cap open ios
```

再於 Xcode 選擇 Apple Developer Team、設定簽章並 Archive，即可安裝到已註冊的 iPhone，或交由 TestFlight／App Store 發布。

下方保留命令列模式的完整設定與操作說明。

**1. 確認 Node.js 可以使用**

開啟 PowerShell，執行：

```powershell
cd D:\codex-project\carories-guard-app2
node --version
```

如果顯示 `v22` 或更高版本，例如 `v24.14.1`，就可以繼續。若找不到 `node`，請從 [Node.js 官網](https://nodejs.org/en/download) 安裝 22 以上版本，安裝後重新開啟 PowerShell。

**2. 在 Google AI Studio 取得 API key**

1. 開啟 [Google AI Studio 的 API Keys 頁面](https://aistudio.google.com/apikey)。
2. 登入 Google 帳號；第一次使用時，依畫面接受服務條款。
3. 新使用者通常會自動取得預設 Google Cloud 專案及 API key。若頁面已有 key，可以開啟並複製。
4. 若要建立新的 key，按 **Create API key**，依畫面選取或建立 Google Cloud 專案，再完成建立。
5. 若已有 Google Cloud 專案，但選單看不到它，先到 **Dashboard → Projects → Import projects** 匯入專案，再回 **API Keys** 建立 key。
6. 複製 key，接著放到本機的 `.env` 檔案。不要把真實 key 貼到聊天室、公開程式碼或 GitHub。

上述專案與金鑰流程以 [Google 官方 API key 教學](https://ai.google.dev/gemini-api/docs/api-key) 為準。Google 自 2026 年 5 月 28 日起，從 AI Studio 建立的新 key 預設為 authorization key；官方也公告在 2026 年 9 月停止接受舊的 standard key。因此，若舊 key 無法使用，請在 AI Studio 建立新的 key。

如果 **Create API key** 顯示沒有權限，需使用有建立 key 權限的專案，或請專案管理員協助。[官方權限排解](https://ai.google.dev/gemini-api/docs/api-key#troubleshooting-key-creation-permissions)

是否有免費額度、可用模型與請求上限，取決於專案及當時的服務規則。請先查看 AI Studio 的使用量與帳務頁面；不要假設大量分析一定免費。[官方帳務說明](https://ai.google.dev/gemini-api/docs/billing)

**3. 把 key 放入程式會讀取的 `.env`**

在專案資料夾的 PowerShell 執行以下指令。它只在 `.env` 尚未存在時複製範本：

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
```

用你慣用的文字編輯器開啟專案中的 `.env`，將內容改成：

```dotenv
GEMINI_API_KEY=在這裡貼上你剛複製的真實API_KEY
GEMINI_MODEL=gemini-3.1-flash-lite
GEMINI_FALLBACK_MODEL=gemini-3.8-flash
```

儲存檔案。範本中的 `your_api_key_here` 是佔位文字，必須替換；也要確認檔名是 `.env`，不是 `.env.txt`。

程式啟動時會讀取 `.env`，因此不用把 key 寫進 `analyze-nutrition.mjs`。`.env` 已列入 Git 忽略規則；分享專案時仍請確認沒有包含這個檔案。

若 PowerShell 已設定同名環境變數，會優先使用環境變數；模型的優先順序是 `--model`、環境變數 `GEMINI_MODEL`、`.env`、程式預設值。本腳本只讀取 `GEMINI_API_KEY` 作為金鑰。`GEMINI_FALLBACK_MODEL` 是主模型遇到持續性暫時錯誤時使用的備援模型。

**4. 準備照片與文字 prompt**

檔案配置如下：

```text
carories-guard-app2/
├── analyze-nutrition.mjs
├── .env
├── .env.example
├── prompt.txt
├── package.json
└── data/
    ├── winston_lunch.jpeg
    └── winston_lunch.annotation.txt
```

`prompt.txt` 是每張照片都會使用的共用要求，可以自行編輯。`data/winston_lunch.annotation.txt` 則只補充 `winston_lunch.jpeg` 的內容。例如：

```text
這是我的午餐，照片裡的食物全部吃完。
白飯是煮熟後 150 公克；雞腿有吃皮；青菜約半碗。
青菜炒菜油約一茶匙，醬汁只吃了一半。
請估算每項食物及整餐的熱量與營養成分。
```

只有確定的資訊才寫明，未知的份量可以直接寫「不知道重量」。程式會把共用 prompt 與該照片的註記合併，再與圖片一起送出。

配對規則：

- `winston_lunch.jpeg` 優先使用 `winston_lunch.annotation.txt`。
- 找不到 `.annotation.txt` 時，才改讀 `winston_lunch.txt`。
- 兩個註記檔都存在時，只使用 `.annotation.txt`；都沒有時，仍使用圖片與共用 prompt。
- 每張圖片代表一份獨立餐點。不要把同一餐的不同角度照片當作不同餐次加總。
- 支援 `.jpg`、`.jpeg`、`.png`、`.webp`、`.heic`、`.heif`；只掃描指定資料夾的第一層，不遞迴掃描子資料夾。[Google 圖片格式說明](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding#supported-image-formats)

照片請保持清楚、方向正確。圖片只能提供估計，實際重量、烹調用油與醬汁會影響結果；提供已知克數與食用比例，有助於縮小誤差。

**5. 先檢查輸入，再正式分析**

先執行離線檢查，確認找到圖片、註記與 prompt：

```powershell
node analyze-nutrition.mjs --dry-run
```

`--dry-run` 不需要 API key，也不會連網或呼叫 Gemini。它不會產生真正的營養分析。

確認無誤後，正式執行：

```powershell
node analyze-nutrition.mjs
```

也可以使用同等指令：

```powershell
npm.cmd run analyze
```

正式執行會把照片和文字內容傳到 Google。每張照片先發出一次 API 請求；遇到 408、429、500、502、503、504 或網路逾時時，每個模型最多共嘗試六次，每次逐步增加等待時間並加入隨機抖動。單次無回應會在 60 秒後重試；主模型在可備援的暫時錯誤上仍失敗時，才會改用 `GEMINI_FALLBACK_MODEL`。因此一次分析可能使用多次請求及相應額度。[Google 官方重試建議](https://ai.google.dev/gemini-api/docs/troubleshooting#retry-strategy)

Windows PowerShell 可能阻擋 `npm.ps1`，因此這份教學使用 `npm.cmd`；直接執行 `node analyze-nutrition.mjs` 也可以。

**6. 查看分析結果**

每次執行有成功的分析時，會建立新的結果子資料夾，例如：

```text
results/
└── <本次執行的時間識別碼>/
    ├── winston_lunch.jpeg.nutrition.json
    └── winston_lunch.jpeg.nutrition.md
```

`.nutrition.md` 適合直接閱讀；`.nutrition.json` 適合後續程式處理。報告列出各項食物、估計份量、營養值及估計時採用的假設。整餐合計由本機程式加總各食物的數值；這能避免合計算錯，但無法讓模型對重量或成分的估計變成實際測量。

實物食物缺少精確資料時，Gemini 會依照片份量與常見食材給出合理估算，並在估算假設或不確定性中說明。若確認為包裝食品，包裝上沒有列出或無法讀到的必填營養項目會填 `0`。品項、各餐與整日總計的營養欄位都會保持為數字，不會留空。

如果圖片不是食物、模型無法分析，或回傳內容不符合要求，程式會回報錯誤，不會捏造營養報告。請依終端機顯示的錯誤處理後再執行。

其他常用操作：

| 參數 | 用途 |
| --- | --- |
| `--dry-run` | 離線檢查輸入，不呼叫 API |
| `--data-dir PATH` | 指定圖片資料夾 |
| `--output-dir PATH` | 指定結果資料夾 |
| `--prompt-file PATH` | 指定共用 prompt 文字檔 |
| `--model ID` | 指定本次呼叫的 Gemini 模型 |
| `--fallback-model ID` | 指定暫時性錯誤時的備援模型；填 `none` 可停用 |
| `--help` | 查看完整操作說明 |

```powershell
node analyze-nutrition.mjs --data-dir "D:\meal-photos" --output-dir ".\meal-results"
node analyze-nutrition.mjs --prompt-file ".\my-prompt.txt"
node analyze-nutrition.mjs --model gemini-3.1-flash-lite
node analyze-nutrition.mjs --model gemini-3.8-flash --fallback-model none
npm.cmd run analyze -- --dry-run
```

沒有指定路徑時，`data`、`prompt.txt`、`.env` 與 `results` 都以 `analyze-nutrition.mjs` 所在資料夾為基準。

手動傳入的相對路徑則以 PowerShell 目前的工作目錄為基準。

常見問題：

- **缺少 API key：** 確認 `.env` 檔名與位置正確，並已將 `your_api_key_here` 換成真實 key。
- **401／403：** 檢查 key 是否有效、所屬專案是否可使用 Gemini API，以及是否仍在使用舊 key。[官方 API key 說明](https://ai.google.dev/gemini-api/docs/api-key)
- **404 或模型不可用：** 到 [官方模型清單](https://ai.google.dev/gemini-api/docs/models) 確認可用模型，再修改 `.env` 的 `GEMINI_MODEL` 或使用 `--model`。
- **429：** 查看 AI Studio 額度與請求限制，稍後再試或調整專案方案。[官方限制說明](https://ai.google.dev/gemini-api/docs/rate-limits)
- **503：** 代表模型暫時過載或服務不可用，通常不是 key 錯誤。程式會優先使用 `gemini-3.1-flash-lite`，並以指數退避重試最多六次；仍失敗時才改用備援模型。[官方錯誤說明](https://ai.google.dev/gemini-api/docs/api-errors)
- **圖片或請求太大：** 縮小圖片後重試。程式接受單張圖片最多 14 MB，編碼後整個請求最多 19 MB，為 Google 的 inline 請求上限保留空間。[官方圖片輸入說明](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding#passing-inline-image-data)

本程式使用 Node.js 內建 `fetch` 呼叫 Gemini REST `generateContent`，以 `inlineData` 傳送圖片，並透過 `generationConfig.responseMimeType` 與 `responseJsonSchema` 要求 JSON 輸出。[官方 REST API 參考](https://ai.google.dev/api/generate-content#v1beta.GenerationConfig)

開發時可執行離線測試；測試不需要 key，也不呼叫 Gemini：

```powershell
npm.cmd test
```
