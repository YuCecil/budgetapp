# 白花嘉麗媽記帳APP

個人記帳 Mobile Web App，消費紀錄存入 Google Sheets。

## 功能

- 新增支出（項目名稱、分類、金額、日期）
- 月份導覽與歷史紀錄查詢
- 圓餅圖視覺化各分類消費佔比（含 hover 互動）
- 預算分類管理與剩餘額度顯示
- 刪除單筆紀錄

## 技術

- React 18 (CDN) + Babel + Tailwind CSS，單一 HTML 檔案
- Google Apps Script 後端，資料寫入 Google Sheets

## 使用方法

1. 建立 Google Sheets 並部署對應的 GAS Web App
2. 將部署 URL 填入 `Index.html` 的 `API_URL` 常數
3. 直接開啟 `Index.html`，或部署至任何靜態主機（GitHub Pages 等）
