# 白花嘉麗媽記帳APP

個人記帳 Mobile Web App，消費紀錄存入 Google Sheets。

## 功能

- 用一句話記帳（「早餐65 捷運25」），由 AI 拆解成多筆
- **記帳前先確認分類**，AI 猜錯可當場改掉再寫入
- 月份導覽與歷史紀錄查詢
- 圓餅圖視覺化各分類消費佔比
- 預算分類管理、群組預算、剩餘額度顯示
- 修改／刪除單筆紀錄
- 對不到類別的花費會明確警示，不會默默從統計中消失

## 專案結構

```
Index.html              前端（實際在跑的是 GitHub Pages 上這一份）
manifest.json           加到主畫面用的設定
icons/                  App 圖示
apps-script/
  Code.js               後端（要部署到 Google Apps Script）
  appsscript.json       Apps Script 專案設定
test/
  test_backend.js       後端測試（模擬 Google 試算表）
```

## 三個部分怎麼組合

| | 是什麼 | 住在哪 |
|---|---|---|
| 前端 | 手機上看到的畫面 | GitHub Pages |
| 後端 | 中間的管家，也負責呼叫 AI | Google Apps Script |
| 資料 | 所有的帳與預算設定 | Google 試算表 |

前端不會直接碰試算表，一律透過後端。

## 密鑰

**程式碼裡不含任何密鑰。** 都放在 Apps Script 的「指令碼屬性」
（編輯器 → ⚙️ 專案設定 → 最下方）：

| 屬性 | 用途 |
|---|---|
| `OPENAI_API_KEY` | 呼叫 OpenAI 拆解記帳文字 |
| `APP_TOKEN` | 通行碼。前端每次請求都會帶上，答不出來就拒絕 |

通行碼由使用者第一次開啟 App 時輸入，存在自己的瀏覽器裡，不寫在程式碼中。

## 開發

```bash
npm test          # 跑後端測試（改 apps-script/Code.js 之後務必跑一次）
```

測試會在本機模擬一個假的 Google 試算表，驗證：無編號資料不會被誤刪、類別改名不會漏帳、
資料整理不會動到帳目、群組預算、金額防呆等。

### 部署後端

裝好 [clasp](https://github.com/google/clasp) 之後可以用指令推送：

```bash
npm install -g @google/clasp
clasp login
cp .clasp.json.example .clasp.json     # 填入你的 scriptId
clasp push
```

`scriptId` 在 Apps Script 編輯器網址列裡：
`script.google.com/home/projects/<scriptId>/edit`

> `clasp push` 只會更新程式碼，**不會**重新部署。改完仍要到
> 「部署 → 管理部署作業 → ✏️ 編輯 → 版本選新版本 → 部署」才會生效。

沒有裝 clasp 的話，就把 `apps-script/Code.js` 全部複製貼到 Apps Script 編輯器裡。

### 部署前端

推到 `main` 即可，GitHub Pages 會自動更新。

## 試算表結構

**記帳資料**

| 欄 | 內容 |
|---|---|
| 1 | 登記時間 |
| 2 | 消費日期 |
| 3 | 月份 |
| 4 | 類別（名稱） |
| 5 | 項目 |
| 6 | 金額 |
| 7 | 備註 |
| 8 | ID |
| 9 | 類別ID |

**設定_YYYY-MM**（每月一張，沒有時退回讀全域的「設定」）

| 欄 | 內容 |
|---|---|
| 1 | ID |
| 2 | 名稱 |
| 3 | 預算 |
| 4 | 群組 |
| 5 | 群組預算（留白則用群組內各類別預算加總） |

第 9 欄與第 5 欄都是**選用的**：沒有值時會自動退回用名稱對帳、用成員加總當群組預算，
所以舊資料不轉檔也能正常運作。

## 維護工具

在 Apps Script 編輯器裡直接執行這些函式（不需要重新部署）：

| 函式 | 用途 |
|---|---|
| `_testDoPost` | 檢查密鑰有沒有設好、後端能不能正常回應 |
| `migrate_1_DryRun` | 試算：列出有幾筆缺編號、缺類別ID。**不會寫入** |
| `migrate_2_Apply` | 補上缺的編號與類別ID。只寫空白格，不動帳目內容 |
| `verify_1_CompareWithBackup` | 與備份逐格比對，確認帳目沒有被改到 |

`migrate_*` 重複執行是安全的，已處理過的不會再動。

## 已知未處理

- 每月預算不會自動接續上個月（新月份會退回讀全域「設定」）
- 每次讀取都會掃描整張表，資料累積到數千筆後會變慢
- 沒有離線功能，沒有網路時無法使用
- 判斷「已刪除」是比對備註欄的文字，若備註剛好含該字串會誤判
- 首次載入需在瀏覽器即時編譯 JSX，約有一兩秒延遲
