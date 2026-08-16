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

if [ ! -f .deployment-id ]; then
  echo "❌ 找不到 .deployment-id"
  echo "   執行 npx clasp list-deployments 找到你的部署 ID，存進這個檔案："
  echo "   echo 'AKfycb...' > .deployment-id"
  exit 1
fi

DEPLOY_ID="$(tr -d '[:space:]' < .deployment-id)"

echo "▸ 1/4 跑測試"
npm test --silent

echo
echo "▸ 2/4 上傳程式碼到 Apps Script"
npx clasp push --force

echo
echo "▸ 3/4 建立新版本"
DESC="${1:-deploy $(date '+%Y-%m-%d %H:%M')}"
VERSION="$(npx clasp create-version "$DESC" --json 2>/dev/null | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).versionNumber' 2>/dev/null || true)"

if [ -z "${VERSION:-}" ]; then
  echo "  （無法自動取得版本號，改用最新版本）"
  VERSION="$(npx clasp list-versions --json 2>/dev/null | node -pe 'const v=JSON.parse(require("fs").readFileSync(0,"utf8"));v[v.length-1].versionNumber' 2>/dev/null)"
fi
echo "  版本 $VERSION"

echo
echo "▸ 4/4 更新線上部署（網址不變）"
npx clasp update-deployment "$DEPLOY_ID" -V "$VERSION" -d "$DESC"

echo
echo "✅ 完成。線上跑的已經是最新的程式碼了。"
