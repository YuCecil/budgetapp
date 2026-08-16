/**
 * 在本機模擬 Google Apps Script 環境，驗證後端行為。
 * 重點驗證「無縫接軌」與「不動到既有資料」。
 */
const fs = require('fs');
const vm = require('vm');

// 測試用的假通行碼，與實際使用的通行碼無關
const TEST_TOKEN = 'test-token-do-not-use';

// ---------- 模擬試算表 ----------
function makeSheet(name, data) {
  const s = {
    name,
    data: data.map(r => r.slice()),
    getName: () => name,
    getLastRow: () => s.data.length,
    getLastColumn: () => s.data.reduce((m, r) => Math.max(m, r.length), 0),
    getDataRange: () => makeRange(s, 1, 1, s.data.length, s.getLastColumn()),
    getRange: (r, c, nr, nc) => makeRange(s, r, c, nr === undefined ? 1 : nr, nc === undefined ? 1 : nc),
    appendRow: (row) => { s.data.push(row.slice()); },
    insertSheet: null,
  };
  return s;
}

function makeRange(sheet, row, col, numRows, numCols) {
  const pad = (r, n) => { while (r.length < n) r.push(''); return r; };
  return {
    getValues() {
      const out = [];
      for (let i = 0; i < numRows; i++) {
        const src = sheet.data[row - 1 + i] || [];
        pad(src, col - 1 + numCols);
        out.push(src.slice(col - 1, col - 1 + numCols));
      }
      return out;
    },
    setValues(vals) {
      vals.forEach((rv, i) => {
        const ri = row - 1 + i;
        if (!sheet.data[ri]) sheet.data[ri] = [];
        pad(sheet.data[ri], col - 1 + numCols);
        rv.forEach((v, j) => { sheet.data[ri][col - 1 + j] = v; });
      });
      return this;
    },
    setValue(v) { return this.setValues([[v]]); },
    setFontWeight() { return this; },
    setBackground() { return this; },
    setHorizontalAlignment() { return this; },
    setNumberFormat() { return this; },
    clearContent() {
      for (let i = 0; i < numRows; i++) {
        const ri = row - 1 + i;
        if (!sheet.data[ri]) continue;
        for (let j = 0; j < numCols; j++) sheet.data[ri][col - 1 + j] = '';
      }
      return this;
    },
  };
}

function makeSpreadsheet(sheets) {
  const map = {};
  sheets.forEach(s => { map[s.name] = s; });
  return {
    getSheetByName: (n) => map[n] || null,
    insertSheet: (n) => { const s = makeSheet(n, []); map[n] = s; return s; },
    _sheets: map,
  };
}

// ---------- 建立測試資料（形狀取自真實試算表）----------
function buildFixture() {
  const data = makeSheet('記帳資料', [
    ['登記時間', '消費日期', '月份', '類別', '項目', '金額', '備註', 'ID'],   // 注意：舊格式，只有 8 欄
    ['2026/05/02 10:20:46', '2026/05/02', '2026/05', '瓦斯費', '瓦斯費', 890, '', 'aaa111'],
    ['2026/05/02 10:24:35', '2026/05/02', '2026/05', '社交娛樂', '餐費', 480, '', 'bbb222'],
    ['2026/05/06 07:55:11', '2026/05/06', '2026/05', '房租', '房租', 12000, '', 'ccc333'],
    ['2026/05/07 07:52:50', '2026/05/07', '2026/05', '餐費', '餐費', 185, '', 'ddd444'],
    // 沒有編號的列（你資料裡那 32 筆的樣子）
    ['', '2026/05/07', '2026/05', '餐費', '餐費', 270, '', ''],
    ['', '2026/05/07', '2026/05', '日用品', '日用品', 128, '', ''],
    ['', '2026/05/07', '2026/05', '社交娛樂', '餐費', 150, '', ''],
    // 已刪除的列
    ['2026/05/08 21:50:55', '2026/05/08', '2026/05', '日用品', '日用品', 783, '(已在 App 刪除)', 'eee555'],
    // 類別名稱在該月設定裡不存在（孤兒資料）
    ['2026/05/09 12:24:58', '2026/05/09', '2026/05', '已消失的類別', '某某', 999, '', 'fff666'],
  ]);

  const config = makeSheet('設定_2026-05', [
    ['ID', '名稱', '預算', '群組'],   // 注意：舊格式，只有 4 欄
    ['1770447359697', '房租', 12000, ''],
    ['1770447415265', '餐費', 8000, ''],
    ['1777688215582', '瓦斯費', 0, '變動費'],
    ['1770804492195', '社交娛樂', 0, '變動費'],
    ['1770804506364', '日用品', 0, '變動費'],
    ['1770804479798', '水費', 15223, '變動費'],
  ]);

  return makeSpreadsheet([data, config]);
}

// ---------- 模擬 GAS 全域物件 ----------
function makeSandbox(ss) {
  const logs = [];
  return {
    logs,
    ctx: vm.createContext({
      SpreadsheetApp: {
        getActiveSpreadsheet: () => ss,
        flush: () => { },
      },
      Utilities: {
        formatDate: (d, tz, fmt) => {
          const p = n => String(n).padStart(2, '0');
          if (fmt === 'yyyy-MM') return `${d.getFullYear()}-${p(d.getMonth() + 1)}`;
          if (fmt === 'yyyy/MM/dd') return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
          return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} 00:00:00`;
        },
      },
      Session: { getScriptTimeZone: () => 'Asia/Taipei' },
      LockService: { getScriptLock: () => ({ waitLock: () => { }, releaseLock: () => { } }) },
      PropertiesService: {
        getScriptProperties: () => ({
          getProperty: (k) => {
            if (k === 'APP_TOKEN') return TEST_TOKEN;
            if (k === 'OPENAI_API_KEY') return 'sk-test';
            return null;          // 其餘屬性（例如 OPENAI_MODEL）預設沒有設定
          },
        }),
      },
      ContentService: {
        createTextOutput: (t) => ({ getContent: () => t, setMimeType: function () { return this; } }),
        MimeType: { JSON: 'json' },
      },
      UrlFetchApp: {
        fetch: (url, opts) => {
          const calls = (globalThis.__fetchCalls = globalThis.__fetchCalls || []);
          calls.push({ url, body: JSON.parse(opts.payload) });
          return globalThis.__fetchReply(calls.length, JSON.parse(opts.payload));
        },
      },
      Logger: { log: (m) => logs.push(String(m)) },
      console,
      Date, Math, JSON, String, Number, Object, Array, isFinite, parseInt,
    }),
  };
}

function load(ss) {
  const box = makeSandbox(ss);
  vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'apps-script', 'Code.js'), 'utf8'), box.ctx);
  return box;
}

function call(ctx, action, payload) {
  const res = vm.runInContext(
    `doPost({postData:{contents: ${JSON.stringify(JSON.stringify(Object.assign({ action, token: TEST_TOKEN }, payload)))} }})`,
    ctx
  );
  return JSON.parse(res.getContent());
}

// ---------- 測試 ----------
let pass = 0, fail = 0;
function check(label, cond, extra) {
  if (cond) { console.log('  ✅ ' + label); pass++; }
  else { console.log('  ❌ ' + label + (extra ? '  → ' + extra : '')); fail++; }
}

console.log('\n【測試 1】舊資料（沒有類別ID、設定只有4欄）能否照常運作 — 無縫接軌');
{
  const ss = buildFixture();
  const box = load(ss);
  const r = call(box.ctx, 'getData', { month: '2026-05' });
  const cat = n => r.categories.find(c => c.name === n);

  check('餐費 = 185 + 270 = 455', cat('餐費').spent === 455, '實際 ' + cat('餐費').spent);
  check('社交娛樂 = 480 + 150 = 630', cat('社交娛樂').spent === 630, '實際 ' + cat('社交娛樂').spent);
  check('房租 = 12000', cat('房租').spent === 12000, '實際 ' + cat('房租').spent);
  check('已刪除的 783 沒有被算進去', cat('日用品').spent === 128, '實際 ' + cat('日用品').spent);
  check('對不到類別的 999 被回報而非默默消失', r.unmatched.count === 1 && r.unmatched.total === 999,
    JSON.stringify(r.unmatched));
  check('群組「變動費」沒設群組預算時，退回成員加總 15223',
    r.groups.find(g => g.name === '變動費').budget === 15223,
    JSON.stringify(r.groups));
}

console.log('\n【測試 2】沒有編號的資料列 — 刪除/修改必須被擋下，不能亂刪');
{
  const ss = buildFixture();
  const box = load(ss);
  const before = JSON.stringify(ss._sheets['記帳資料'].data);

  const d1 = call(box.ctx, 'deleteData', { id: '' });
  const d2 = call(box.ctx, 'deleteData', {});
  const u1 = call(box.ctx, 'updateData', { id: '', amount: 1, item: 'x' });

  check('空字串編號的刪除被拒絕', d1.status === 'error');
  check('完全沒帶編號的刪除被拒絕', d2.status === 'error');
  check('空字串編號的修改被拒絕', u1.status === 'error');
  check('資料完全沒被動到', JSON.stringify(ss._sheets['記帳資料'].data) === before);

  const ok = call(box.ctx, 'deleteData', { id: 'aaa111' });
  check('正常編號的刪除仍可運作', ok.status === 'deleted', JSON.stringify(ok));
}

console.log('\n【測試 3】資料整理 — 只補空格，絕不改動帳目內容');
{
  const ss = buildFixture();
  const box = load(ss);
  const sheet = ss._sheets['記帳資料'];
  const snapshot = sheet.data.map(r => r.slice());

  vm.runInContext('migrate_2_Apply()', box.ctx);

  const COLS = { TIME: 0, DATE: 1, MONTH: 2, CAT: 3, ITEM: 4, AMOUNT: 5, NOTE: 6, ID: 7, CATID: 8 };
  let untouched = true, detail = '';
  for (let i = 1; i < snapshot.length; i++) {
    [COLS.TIME, COLS.DATE, COLS.MONTH, COLS.CAT, COLS.ITEM, COLS.AMOUNT, COLS.NOTE].forEach(c => {
      if (String(snapshot[i][c] ?? '') !== String(sheet.data[i][c] ?? '')) {
        untouched = false;
        detail += `第${i + 1}列第${c + 1}欄 "${snapshot[i][c]}"→"${sheet.data[i][c]}" `;
      }
    });
  }
  check('登記時間/日期/月份/類別/項目/金額/備註 全部沒變', untouched, detail);

  const blanks = sheet.data.slice(1).filter(r => !String(r[COLS.ID] || '').trim());
  check('所有資料列都有編號了', blanks.length === 0, '仍有 ' + blanks.length + ' 筆空白');

  const ids = sheet.data.slice(1).map(r => String(r[COLS.ID]));
  check('編號沒有重複', new Set(ids).size === ids.length);

  const withCat = sheet.data.slice(1).filter(r => String(r[COLS.CATID] || '').trim());
  // fixture 共 9 列資料，其中 1 列的類別在設定裡不存在（孤兒），所以應補上 8 筆
  check('能對到類別的 8 列都補上了類別ID（1 筆孤兒維持空白）',
    withCat.length === 8, '實際 ' + withCat.length);

  check('標題列補上了「類別ID」', sheet.data[0][COLS.CATID] === '類別ID', String(sheet.data[0][COLS.CATID]));

  // 整理後，金額統計必須跟整理前完全一致
  const r2 = call(box.ctx, 'getData', { month: '2026-05' });
  const c = n => r2.categories.find(x => x.name === n).spent;
  check('整理後：餐費仍是 455', c('餐費') === 455, '實際 ' + c('餐費'));
  check('整理後：社交娛樂仍是 630', c('社交娛樂') === 630, '實際 ' + c('社交娛樂'));
  check('整理後：日用品仍是 128', c('日用品') === 128, '實際 ' + c('日用品'));
}

console.log('\n【測試 4】類別改名之後，花費還在不在 — 這是那 674 元的根治測試');
{
  const ss = buildFixture();
  const box = load(ss);

  // 先整理（補上類別ID）
  vm.runInContext('migrate_2_Apply()', box.ctx);

  const before = call(box.ctx, 'getData', { month: '2026-05' });
  const beforeSpent = before.categories.find(c => c.name === '社交娛樂').spent;

  // 模擬使用者把「社交娛樂」改名成「社交娛樂費」
  const cfg = ss._sheets['設定_2026-05'];
  const row = cfg.data.find(r => r[1] === '社交娛樂');
  row[1] = '社交娛樂費';

  const after = call(box.ctx, 'getData', { month: '2026-05' });
  const afterCat = after.categories.find(c => c.name === '社交娛樂費');

  check('改名前 社交娛樂 = 630', beforeSpent === 630, '實際 ' + beforeSpent);
  check('改名後 花費完整保留 = 630 (舊版會變成 0)', afterCat.spent === 630, '實際 ' + afterCat.spent);
  check('改名後沒有產生任何對不到的花費', after.unmatched.total === 999,
    '應該只剩原本那筆孤兒 999，實際 ' + after.unmatched.total);
}

console.log('\n【測試 5】群組預算 — 可以直接設定，不用再硬塞在水費');
{
  const ss = buildFixture();
  const box = load(ss);

  const r0 = call(box.ctx, 'getData', { month: '2026-05' });
  const cats = r0.categories.map(c => ({ id: c.id, name: c.name, budget: c.budget, group: c.group }));

  // 把水費的 15223 歸零，改成直接設定群組預算
  cats.find(c => c.name === '水費').budget = 0;
  const saved = call(box.ctx, 'saveConfig', {
    month: '2026-05',
    categories: cats,
    groupBudgets: { '變動費': 15223 },
  });
  check('設定儲存成功', saved.status === 'saved', JSON.stringify(saved));

  const r1 = call(box.ctx, 'getData', { month: '2026-05' });
  const g = r1.groups.find(x => x.name === '變動費');
  check('群組預算 = 15223（明確設定）', g.budget === 15223 && g.explicit === true, JSON.stringify(g));
  check('水費本身的預算已歸零', r1.categories.find(c => c.name === '水費').budget === 0);
  check('其他類別的花費統計不受影響', r1.categories.find(c => c.name === '餐費').spent === 455);
}

console.log('\n【測試 6】金額防呆');
{
  const ss = buildFixture();
  const box = load(ss);
  const rowsBefore = ss._sheets['記帳資料'].data.length;

  check('文字金額被拒絕', call(box.ctx, 'addData', { item: 'x', amount: 'abc', month: '2026-05', category: '餐費' }).status === 'error');
  check('缺項目被拒絕', call(box.ctx, 'addData', { amount: 100, month: '2026-05', category: '餐費' }).status === 'error');
  check('沒有寫入任何爛資料', ss._sheets['記帳資料'].data.length === rowsBefore);

  const good = call(box.ctx, 'addData', { item: '早餐', amount: '65', month: '2026-05', category: '餐費', categoryId: '1770447415265', date: '2026-05-15', id: 'newid1' });
  check('字串數字 "65" 被正確轉成數字並寫入', good.status === 'success');
  const last = ss._sheets['記帳資料'].data[ss._sheets['記帳資料'].data.length - 1];
  check('寫入的金額是數字 65', last[5] === 65, typeof last[5] + ' ' + last[5]);
  check('寫入了類別ID', last[8] === '1770447415265', String(last[8]));
}


console.log('\n【測試 7】AI 拆解 — 模型設定、結構化輸出、壞資料防呆');
{
  const ss = buildFixture();
  const box = load(ss);

  const ok = (txs) => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ transactions: txs }) } }] }),
  });

  // --- 正常情況 ---
  globalThis.__fetchCalls = [];
  globalThis.__fetchReply = () => ok([
    { item: '早餐', amount: 65, categoryId: '1770447415265', date: '2026/05/15' },
  ]);
  let r = call(box.ctx, 'analyze', { text: '早餐65', categories: [{ id: '1770447415265', name: '餐費' }], currentDate: '2026/05/15' });
  let sent = globalThis.__fetchCalls[0].body;

  check('用的是 gpt-5.6-luna', sent.model === 'gpt-5.6-luna', sent.model);
  check('有帶 reasoning_effort', sent.reasoning_effort === 'low', String(sent.reasoning_effort));
  check('用 json_schema 強制回傳結構', sent.response_format.type === 'json_schema', sent.response_format.type);
  check('schema 為 strict', sent.response_format.json_schema.strict === true);
  check('沒有帶 GPT-5 不支援的 temperature', sent.temperature === undefined);
  check('沒有帶已淘汰的 max_tokens', sent.max_tokens === undefined);
  check('提示詞裡的星期正確 (2026/05/15 是星期五)',
    sent.messages[0].content.includes('星期五'), sent.messages[0].content.slice(0, 40));
  check('成功解析出交易', r.status === 'success' && r.data.transactions.length === 1, JSON.stringify(r).slice(0, 120));

  // --- 模型可用指令碼屬性覆寫 ---
  const box2 = load(buildFixture());
  vm.runInContext("PropertiesService.getScriptProperties = () => ({ getProperty: (k) => k === 'APP_TOKEN' ? TEST_TOKEN_X : (k === 'OPENAI_MODEL' ? 'gpt-5.6-terra' : 'sk-test') });", box2.ctx);
  vm.runInContext(`TEST_TOKEN_X = ${JSON.stringify(TEST_TOKEN)};`, box2.ctx);
  globalThis.__fetchCalls = [];
  call(box2.ctx, 'analyze', { text: 'x 1', categories: [{ id: '1', name: 'A' }], currentDate: '2026/05/15' });
  check('OPENAI_MODEL 可覆寫預設模型',
    globalThis.__fetchCalls[0].body.model === 'gpt-5.6-terra', globalThis.__fetchCalls[0].body.model);

  // --- 400 時自動退回相容寫法 ---
  const box3 = load(buildFixture());
  globalThis.__fetchCalls = [];
  globalThis.__fetchReply = (n) => n === 1
    ? { getResponseCode: () => 400, getContentText: () => JSON.stringify({ error: { message: 'Unsupported parameter' } }) }
    : ok([{ item: '早餐', amount: 65, categoryId: '1', date: '2026/05/15' }]);
  r = call(box3.ctx, 'analyze', { text: '早餐65', categories: [{ id: '1', name: '餐費' }], currentDate: '2026/05/15' });
  check('第一次 400 會自動重試', globalThis.__fetchCalls.length === 2, '呼叫了 ' + globalThis.__fetchCalls.length + ' 次');
  check('重試時改用相容的 json_object',
    globalThis.__fetchCalls[1].body.response_format.type === 'json_object',
    globalThis.__fetchCalls[1].body.response_format.type);
  check('重試時不再帶 reasoning_effort', globalThis.__fetchCalls[1].body.reasoning_effort === undefined);
  check('退回之後仍然成功', r.status === 'success', JSON.stringify(r).slice(0, 100));

  // --- 壞資料防呆 ---
  const box4 = load(buildFixture());
  globalThis.__fetchCalls = [];
  globalThis.__fetchReply = () => ok([
    { item: '早餐', amount: '65', categoryId: '1', date: '2026/05/15' },   // 字串金額
    { item: '壞的', amount: 'abc', categoryId: '1', date: '2026/05/15' },  // 無效金額
    { item: '', amount: 30, categoryId: '1', date: '2026/05/15' },         // 沒有項目名稱
  ]);
  r = call(box4.ctx, 'analyze', { text: 'x', categories: [{ id: '1', name: '餐費' }], currentDate: '2026/05/15' });
  const txs = r.data.transactions;
  check('無效金額的那筆被剔除', txs.length === 2, '剩下 ' + txs.length + ' 筆');
  check('字串 "65" 被轉成數字 65', txs[0].amount === 65 && typeof txs[0].amount === 'number', typeof txs[0].amount);
  check('空白項目補上預設名稱', txs[1].item === '未命名', txs[1].item);

  // --- 兩次都失敗時要回報錯誤，不能假裝成功 ---
  const box5 = load(buildFixture());
  globalThis.__fetchReply = () => ({
    getResponseCode: () => 500,
    getContentText: () => JSON.stringify({ error: { message: 'server error' } }),
  });
  r = call(box5.ctx, 'analyze', { text: 'x', categories: [{ id: '1', name: 'A' }], currentDate: '2026/05/15' });
  check('API 失敗時回報錯誤', r.status === 'error' && /server error/.test(r.message), JSON.stringify(r).slice(0, 120));
}


console.log('\n【測試 8】「餐費200+300+58」這種寫法');
{
  const ss = buildFixture();
  const box = load(ss);

  const ok = (txs) => ({
    getResponseCode: () => 200,
    getContentText: () => JSON.stringify({ choices: [{ message: { content: JSON.stringify({ transactions: txs }) } }] }),
  });

  // 提示詞要明確告訴模型怎麼理解加號
  globalThis.__fetchCalls = [];
  globalThis.__fetchReply = () => ok([
    { item: '餐費', amount: 200, categoryId: '1', date: '2026/05/15' },
    { item: '餐費', amount: 300, categoryId: '1', date: '2026/05/15' },
    { item: '餐費', amount: 58, categoryId: '1', date: '2026/05/15' },
  ]);
  let r = call(box.ctx, 'analyze', { text: '餐費200+300+58', categories: [{ id: '1', name: '餐費' }], currentDate: '2026/05/15' });
  const prompt = globalThis.__fetchCalls[0].body.messages[0].content;

  check('提示詞有說明加號代表分開的多筆', prompt.includes('THREE transactions of 200, 300 and 58'));
  check('提示詞有禁止回傳算式', prompt.includes('Never return an expression'));
  check('提示詞有涵蓋空白分隔的寫法', prompt.includes('"餐費 200 300 58"'));
  check('三筆都被正確解析', r.data.transactions.length === 3, '得到 ' + r.data.transactions.length + ' 筆');
  check('金額分別是 200 / 300 / 58',
    r.data.transactions.map(t => t.amount).join(',') === '200,300,58',
    r.data.transactions.map(t => t.amount).join(','));

  // 降級路徑：模型硬是回傳字串算式時，加總而不是整筆丟掉
  const box2 = load(buildFixture());
  globalThis.__fetchReply = () => ok([{ item: '餐費', amount: '200+300+58', categoryId: '1', date: '2026/05/15' }]);
  r = call(box2.ctx, 'analyze', { text: '餐費200+300+58', categories: [{ id: '1', name: '餐費' }], currentDate: '2026/05/15' });
  check('字串算式會被加總成 558 而不是消失',
    r.data.transactions.length === 1 && r.data.transactions[0].amount === 558,
    JSON.stringify(r.data.transactions));

  // 真正無效的字串仍然要被剔除，不能誤判
  const box3 = load(buildFixture());
  globalThis.__fetchReply = () => ok([
    { item: 'a', amount: '200+abc', categoryId: '1', date: '2026/05/15' },
    { item: 'b', amount: '1+2+3', categoryId: '1', date: '2026/05/15' },
  ]);
  r = call(box3.ctx, 'analyze', { text: 'x', categories: [{ id: '1', name: '餐費' }], currentDate: '2026/05/15' });
  check('含文字的算式仍被剔除', r.data.transactions.length === 1, JSON.stringify(r.data.transactions));
  check('合法算式 1+2+3 = 6', r.data.transactions[0].amount === 6, String(r.data.transactions[0].amount));
}

console.log('\n' + '='.repeat(52));
console.log(`通過 ${pass} 項，失敗 ${fail} 項`);
console.log('='.repeat(52));
process.exit(fail ? 1 : 0);
