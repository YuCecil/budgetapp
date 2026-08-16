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
  echo "   執行 npx clasp list-deployments 找到部署 ID，存進這個檔案："
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

# 部署後一定要確認線上真的活著。曾經發生過部署完卻對所有人 403，
# 而且沒人察覺的狀況；寧可在這裡吵，也不要讓使用者先遇到。
echo
echo "▸ 驗證線上狀態"
URL="https://script.google.com/macros/s/$DEPLOY_ID/exec"
OK=""
for i in 1 2 3 4 5; do
  sleep 5
  if curl -sL "$URL?cb=$RANDOM" | grep -q "API is running"; then OK="yes"; break; fi
  echo "  等待生效... ($((i*5))s)"
done

if [ -n "$OK" ]; then
  echo "  ✅ 線上正常回應，匿名可存取"
  echo
  echo "✅ 完成。跑的是版本 $VERSION。"
else
  echo "  ❌ 線上沒有正常回應！App 可能對所有人壞掉了。"
  echo
  echo "  請到 Apps Script 手動處理："
  echo "    部署 → 管理部署作業 → ✏️ 編輯 → 版本選 $VERSION → 部署"
  echo "    存取權要是「任何人」。若跳出授權視窗，請允許。"
  exit 1
fi
