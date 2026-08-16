#!/usr/bin/env bash
# 一行指令完成後端部署：跑測試 → 上傳程式碼 → 建立版本 → 更新線上部署
# 用法： npm run deploy
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .clasp.json ]; then
  echo "❌ 找不到 .clasp.json"
  echo "   請複製 .clasp.json.example 成 .clasp.json，並填入你的 scriptId"
  exit 1
fi

echo "▸ 1/3 跑測試"
npm test --silent

echo
echo "▸ 2/3 上傳程式碼到 Apps Script"
npx clasp push --force

echo
echo "▸ 3/3 建立新版本"
DESC="${1:-deploy $(date '+%Y-%m-%d %H:%M')}"
VERSION="$(npx clasp create-version "$DESC" --json 2>/dev/null | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).versionNumber' 2>/dev/null || true)"

if [ -z "${VERSION:-}" ]; then
  echo "  （無法自動取得版本號，改用最新版本）"
  VERSION="$(npx clasp list-versions --json 2>/dev/null | node -pe 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));v[v.length-1].versionNumber' 2>/dev/null)"
fi
echo "  版本 $VERSION"

echo
echo "──────────────────────────────────────────────"
echo "✅ 程式碼已上傳，版本 $VERSION 已建立。"
echo
echo "⚠️  最後一步請到網頁介面完成（這一步不能用指令代替）："
echo "   部署 → 管理部署作業 → ✏️ 編輯 → 版本選 $VERSION → 部署"
echo
echo "   原因：用 API 更新部署會把「任何人都能存取」的設定清掉，"
echo "   導致 App 對所有人回傳 403。"
echo "──────────────────────────────────────────────"
