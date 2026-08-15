/**
 * 公開 API 版後端
 * 供 GitHub Pages 等外部前端呼叫
 */

// ==========================================
// 安全設定區
// ------------------------------------------
// 密鑰「不再寫在程式碼裡」，改放到 Apps Script 的「指令碼屬性」。
// 設定位置：Apps Script 編輯器 → 左側齒輪「專案設定」→ 最下方「指令碼屬性」
//
//   OPENAI_API_KEY  = 你的 OpenAI 金鑰 (sk-proj-...)
//   APP_TOKEN       = 你自訂的通行碼 (給自己和朋友用的密碼)
//
// 這樣程式碼就算被別人看到，也拿不到任何密鑰。
// ==========================================

// ==========================================
// 欄位定義
// ------------------------------------------
// 「類別ID」(第9欄) 與「群組預算」(第5欄) 都是後來新增的，且皆為選用：
// 沒有值時會自動退回用「類別名稱」對帳、用「成員預算加總」當群組預算。
// 因此舊資料不需要先轉檔也能正常運作。
// ==========================================

var DATA_HEADERS = ["登記時間", "消費日期", "月份", "類別", "項目", "金額", "備註", "ID", "類別ID"];
var CONFIG_HEADERS = ["ID", "名稱", "預算", "群組", "群組預算"];

// 記帳資料的欄位索引 (0-based，對應上面的 DATA_HEADERS)
var D_TIME = 0, D_DATE = 1, D_MONTH = 2, D_CAT = 3, D_ITEM = 4, D_AMOUNT = 5, D_NOTE = 6, D_ID = 7, D_CATID = 8;
// 設定表的欄位索引
var C_ID = 0, C_NAME = 1, C_BUDGET = 2, C_GROUP = 3, C_GROUPBUDGET = 4;

var DELETED_MARK = "已在 App 刪除";


function _getConfig(key) {
    return PropertiesService.getScriptProperties().getProperty(key);
}

function _firstRunAuth() {
    console.log("正在檢查連線權限...");
    UrlFetchApp.fetch("https://www.google.com");
    console.log("權限檢查通過！");
}

function doGet(e) {
    return ContentService.createTextOutput("API is running.");
}

function doPost(e) {
    var request;
    try {
        request = JSON.parse(e.postData.contents);
    } catch (err) {
        return _jsonResponse({ status: 'error', message: 'Invalid JSON' });
    }

    // --- 通行碼檢查：擋掉不知道通行碼的陌生人 ---
    var expectedToken = _getConfig('APP_TOKEN');
    if (!expectedToken) {
        return _jsonResponse({ status: 'error', message: '伺服器尚未設定 APP_TOKEN，請到「專案設定 → 指令碼屬性」新增' });
    }
    if (request.token !== expectedToken) {
        // code: 'unauthorized' 讓前端知道要重新詢問通行碼
        return _jsonResponse({ status: 'error', code: 'unauthorized', message: '通行碼錯誤' });
    }

    var action = request.action;

    if (action === 'getData') {
        return _getData(request.month);
    } else if (action === 'addData') {
        return _addData(request);
    } else if (action === 'deleteData') {
        return _deleteData(request);
    } else if (action === 'saveConfig') {
        return _saveConfig(request);
    } else if (action === 'updateData') {
        return _updateData(request);
    } else if (action === 'analyze') {
        return _analyzeText(request.text, request.categories, request.currentDate);
    }

    return _jsonResponse({ status: 'error', message: 'Unknown action' });
}

// --- 共用工具 ---

function _normMonth(raw) {
    if (raw instanceof Date) {
        return Utilities.formatDate(raw, Session.getScriptTimeZone(), "yyyy-MM");
    }
    return String(raw || "").replace(/\//g, '-').slice(0, 7);
}

function _toAmount(value) {
    var n = Number(value);
    if (!isFinite(n)) return null;
    return n;
}

function _newId() {
    return Math.random().toString(36).slice(2, 11) + Date.now().toString();
}

function _isDeleted(note) {
    return String(note || "").indexOf(DELETED_MARK) !== -1;
}


function _analyzeText(text, categories, currentDateStr) {
    var OPENAI_API_KEY = _getConfig('OPENAI_API_KEY');
    if (!OPENAI_API_KEY) {
        return _jsonResponse({ status: 'error', message: '伺服器尚未設定 OPENAI_API_KEY，請到「專案設定 → 指令碼屬性」新增' });
    }

    var categoryList = categories.map(function (c) { return c.id + ":" + c.name; }).join(', ');

    var todayStr = currentDateStr || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");
    // 星期必須從 todayStr 推導，不能用伺服器的當下時間，否則兩者可能互相矛盾
    var parts = todayStr.replace(/-/g, '/').split('/');
    var refDate = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var dayOfWeek = ['日', '一', '二', '三', '四', '五', '六'][refDate.getDay()];

    var prompt =
        "Current Date: " + todayStr + " (星期" + dayOfWeek + ")\n" +
        "User Input: \"" + text + "\"\n" +
        "Categories: " + categoryList + "\n\n" +
        "Task: Extract ALL transactions from the text.\n" +
        "For each transaction identify:\n" +
        "1. item (noun)\n" +
        "2. amount (number)\n" +
        "3. categoryId (match best fit ID. If NO fit, set to \"OTHER\")\n" +
        "4. date (Format: YYYY/MM/DD, inferred from context like \"yesterday\", \"morning\" implies today, etc. Default to Current Date).\n\n" +
        "IMPORTANT category rules:\n" +
        "- If a word in the text is identical or nearly identical to a category name, you MUST use that category. " +
        "Example: text \"餐費 480\" with a category named \"餐費\" MUST map to 餐費, never to a different category.\n" +
        "- Do not merge distinct categories. 餐費 (food) is never 社交娛樂 (social/entertainment).\n" +
        "- Only guess when the text gives no direct category match.\n\n" +
        "Return JSON: { \"transactions\": [ { \"amount\": number, \"categoryId\": \"id\", \"item\": \"string\", \"date\": \"YYYY/MM/DD\" }, ... ] }";

    var url = "https://api.openai.com/v1/chat/completions";
    var payload = {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt + " Return JSON only." }],
        response_format: { type: "json_object" }
    };

    var options = {
        method: "post",
        contentType: "application/json",
        headers: { "Authorization": "Bearer " + OPENAI_API_KEY },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
    };

    try {
        var response = UrlFetchApp.fetch(url, options);
        var responseCode = response.getResponseCode();
        var responseBody = JSON.parse(response.getContentText());

        if (responseCode !== 200) {
            return _jsonResponse({ status: 'error', message: 'OpenAI Error: ' + (responseBody.error ? responseBody.error.message : 'Unknown') });
        }

        var content = responseBody.choices[0].message.content;
        var result = JSON.parse(content);

        // 金額防呆：AI 有時會回傳字串或無效值，這裡統一轉成數字並剔除壞資料
        var clean = [];
        (result.transactions || []).forEach(function (t) {
            var amt = _toAmount(t.amount);
            if (amt === null) return;
            clean.push({
                amount: amt,
                categoryId: String(t.categoryId || 'OTHER'),
                item: String(t.item || '').trim() || '未命名',
                date: String(t.date || todayStr)
            });
        });

        return _jsonResponse({ status: 'success', data: { transactions: clean } });

    } catch (e) {
        return _jsonResponse({ status: 'error', message: 'Fetch Error: ' + e.toString() });
    }
}


function _readConfigSheet(ss, month) {
    // 先找該月份的專屬設定，沒有就退回全域「設定」
    var configSheet = ss.getSheetByName("設定_" + month) || ss.getSheetByName("設定");

    if (!configSheet) {
        configSheet = ss.insertSheet("設定");
        configSheet.appendRow(CONFIG_HEADERS);
        configSheet.getRange(1, 1, 1, CONFIG_HEADERS.length).setFontWeight("bold").setBackground("#fcd34d");
        [
            ['1', '餐費', 6000, '', ''],
            ['2', '交通費', 1200, '', ''],
            ['3', '水費', 500, '變動費', ''],
            ['4', '日用品', 2000, '變動費', '']
        ].forEach(function (r) { configSheet.appendRow(r); });
    }

    return configSheet;
}

function _getData(targetMonth) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var currentMonth = _normMonth(targetMonth || Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy-MM"));

    var configSheet = _readConfigSheet(ss, currentMonth);
    var sheet = _getDataSheet(ss);

    var categories = [];
    var groupBudgets = {};   // 群組名稱 -> 明確設定的預算
    var rows = configSheet.getDataRange().getValues();

    for (var i = 1; i < rows.length; i++) {
        if (!rows[i][C_ID]) continue;
        var group = rows[i][C_GROUP] ? String(rows[i][C_GROUP]) : "";
        categories.push({
            id: String(rows[i][C_ID]),
            name: rows[i][C_NAME],
            budget: Number(rows[i][C_BUDGET]) || 0,
            group: group,
            spent: 0
        });
        // 群組預算寫在該群組任一列即可，取第一個有值的
        if (group && rows[i][C_GROUPBUDGET] !== "" && rows[i][C_GROUPBUDGET] !== undefined && groupBudgets[group] === undefined) {
            var gb = Number(rows[i][C_GROUPBUDGET]);
            if (isFinite(gb)) groupBudgets[group] = gb;
        }
    }

    // 建立查表：以類別ID與名稱各做一份，方便快速比對
    var byId = {}, byName = {};
    categories.forEach(function (c) {
        byId[c.id] = c;
        if (byName[c.name] === undefined) byName[c.name] = c;
    });

    var history = [];
    var unmatched = { count: 0, total: 0, names: [] };

    if (sheet.getLastRow() > 1) {
        var allData = sheet.getDataRange().getValues();
        for (var j = allData.length - 1; j >= 1; j--) {
            var row = allData[j];
            if (_isDeleted(row[D_NOTE])) continue;
            if (_normMonth(row[D_MONTH]) !== currentMonth) continue;

            var amount = _toAmount(row[D_AMOUNT]) || 0;

            // 對帳優先序：類別ID > 類別名稱。舊資料沒有類別ID，會自動走名稱。
            var rowCatId = row[D_CATID] !== undefined && row[D_CATID] !== null ? String(row[D_CATID]) : "";
            var cat = (rowCatId && byId[rowCatId]) ? byId[rowCatId] : byName[row[D_CAT]];

            if (cat) {
                cat.spent += amount;
            } else {
                // 對不到類別的花費不再默默消失，改為回報給前端提示
                unmatched.count++;
                unmatched.total += amount;
                var nm = String(row[D_CAT] || '(空白)');
                if (unmatched.names.indexOf(nm) === -1) unmatched.names.push(nm);
            }

            if (history.length < 200) {
                var d = row[D_DATE];
                if (d instanceof Date) d = Utilities.formatDate(d, Session.getScriptTimeZone(), "yyyy/MM/dd");
                history.push({
                    id: String(row[D_ID] || ''),
                    date: d,
                    month: currentMonth,
                    categoryName: row[D_CAT],
                    item: row[D_ITEM],
                    amount: amount,
                    categoryId: cat ? cat.id : '',
                    matched: !!cat
                });
            }
        }
    }

    // 整理群組資訊：有明確預算就用，沒有就退回「成員預算加總」(維持舊行為)
    var groups = [];
    var seen = {};
    categories.forEach(function (c) {
        if (!c.group || seen[c.group]) return;
        seen[c.group] = true;
        var members = categories.filter(function (x) { return x.group === c.group; });
        var sum = members.reduce(function (a, x) { return a + x.budget; }, 0);
        var explicit = groupBudgets[c.group] !== undefined;
        groups.push({
            name: c.group,
            budget: explicit ? groupBudgets[c.group] : sum,
            explicit: explicit
        });
    });

    return _jsonResponse({
        categories: categories,
        groups: groups,
        history: history,
        month: currentMonth,
        unmatched: unmatched
    });
}


function _addData(data) {
    // 原本用 && 判斷，導致「有金額但沒項目」的爛資料也能寫入；改成 || 才是正確的防呆
    if (!data.item || data.amount === undefined || data.amount === null) {
        return _jsonResponse({ status: 'error', message: '缺少項目或金額' });
    }
    var amount = _toAmount(data.amount);
    if (amount === null) {
        return _jsonResponse({ status: 'error', message: '金額不是有效數字' });
    }

    var lock = LockService.getScriptLock();
    try {
        lock.waitLock(10000); // 最多等待 10 秒
        var ss = SpreadsheetApp.getActiveSpreadsheet();
        var sheet = _getDataSheet(ss);
        _ensureDataHeaders(sheet);

        var entryTime = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd HH:mm:ss");
        var txDate = data.date ? String(data.date).replace(/-/g, '/') : Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyy/MM/dd");

        sheet.appendRow([
            entryTime, txDate, data.month, data.category, data.item, amount,
            data.note || "", data.id || _newId(), data.categoryId || ""
        ]);

        var last = sheet.getLastRow();
        sheet.getRange(last, 1, 1, DATA_HEADERS.length).setHorizontalAlignment("left");
        sheet.getRange(last, 1).setNumberFormat("yyyy/mm/dd HH:mm:ss");
        SpreadsheetApp.flush();
    } catch (e) {
        return _jsonResponse({ status: 'error', message: '系統忙碌中，請稍後重試 (' + e.message + ')' });
    } finally {
        lock.releaseLock();
    }

    return _jsonResponse({ status: 'success' });
}


function _findRowById(rows, id) {
    // 空白 ID 絕對不能拿來比對，否則會match到其他同樣空白的列而改錯／刪錯資料
    if (id === undefined || id === null || String(id).trim() === '') return -1;
    var target = String(id).trim();
    for (var i = 1; i < rows.length; i++) {
        if (String(rows[i][D_ID]).trim() === target) return i;
    }
    return -1;
}

function _updateData(data) {
    if (!data.id || String(data.id).trim() === '') {
        return _jsonResponse({ status: 'error', message: '這筆資料沒有編號，無法安全修改。請先執行一次資料整理 (migrate_2_Apply)。' });
    }
    var amount = _toAmount(data.amount);
    if (amount === null) {
        return _jsonResponse({ status: 'error', message: '金額不是有效數字' });
    }

    var lock = LockService.getScriptLock();
    try {
        lock.waitLock(10000);
        var sheet = _getDataSheet(SpreadsheetApp.getActiveSpreadsheet());
        _ensureDataHeaders(sheet);
        var rows = sheet.getDataRange().getValues();
        var i = _findRowById(rows, data.id);
        if (i === -1) return _jsonResponse({ status: 'not_found' });

        var txDate = data.date ? String(data.date).replace(/-/g, '/') : rows[i][D_DATE];
        var txMonth = data.date ? String(data.date).slice(0, 7) : rows[i][D_MONTH];

        sheet.getRange(i + 1, D_DATE + 1).setValue(txDate);
        sheet.getRange(i + 1, D_MONTH + 1).setValue(txMonth);
        sheet.getRange(i + 1, D_CAT + 1).setValue(data.category);
        sheet.getRange(i + 1, D_ITEM + 1).setValue(data.item);
        sheet.getRange(i + 1, D_AMOUNT + 1).setValue(amount);
        sheet.getRange(i + 1, D_CATID + 1).setValue(data.categoryId || "");
        SpreadsheetApp.flush();
        return _jsonResponse({ status: 'updated' });
    } catch (e) {
        return _jsonResponse({ status: 'error', message: '系統忙碌中，請稍後重試 (' + e.message + ')' });
    } finally {
        lock.releaseLock();
    }
}

function _deleteData(data) {
    if (!data.id || String(data.id).trim() === '') {
        return _jsonResponse({ status: 'error', message: '這筆資料沒有編號，為避免刪錯其他資料已停止。請先執行一次資料整理 (migrate_2_Apply)。' });
    }

    var lock = LockService.getScriptLock();
    try {
        lock.waitLock(10000);
        var sheet = _getDataSheet(SpreadsheetApp.getActiveSpreadsheet());
        var rows = sheet.getDataRange().getValues();
        var i = _findRowById(rows, data.id);
        if (i === -1) return _jsonResponse({ status: 'not_found' });

        var currentNote = rows[i][D_NOTE];
        var newNote = currentNote ? currentNote + " (" + DELETED_MARK + ")" : "(" + DELETED_MARK + ")";
        sheet.getRange(i + 1, D_NOTE + 1).setValue(newNote);
        SpreadsheetApp.flush();
        return _jsonResponse({ status: 'deleted' });
    } catch (e) {
        return _jsonResponse({ status: 'error', message: '系統忙碌中，請稍後重試 (' + e.message + ')' });
    } finally {
        lock.releaseLock();
    }
}


function _saveConfig(data) {
    var lock = LockService.getScriptLock();
    try {
        lock.waitLock(10000);
        var ss = SpreadsheetApp.getActiveSpreadsheet();

        var targetMonth = data.month;
        if (!targetMonth) throw new Error("缺少月份參數");

        var configSheetName = "設定_" + targetMonth;
        var configSheet = ss.getSheetByName(configSheetName) || ss.insertSheet(configSheetName);

        var groupBudgets = data.groupBudgets || {};
        var values = [CONFIG_HEADERS.slice()];

        (data.categories || []).forEach(function (c) {
            var group = c.group || "";
            var gb = "";
            if (group && groupBudgets[group] !== undefined && groupBudgets[group] !== null && groupBudgets[group] !== "") {
                var n = Number(groupBudgets[group]);
                if (isFinite(n)) gb = n;
            }
            values.push([c.id, c.name, Number(c.budget) || 0, group, gb]);
        });

        var oldRows = configSheet.getLastRow();

        // 先寫入新資料再清掉多餘的舊列，避免「先清空後寫入」中途失敗導致設定整個消失
        configSheet.getRange(1, 1, values.length, CONFIG_HEADERS.length).setValues(values);
        configSheet.getRange(1, 1, 1, CONFIG_HEADERS.length).setFontWeight("bold").setBackground("#fcd34d");

        if (oldRows > values.length) {
            configSheet.getRange(values.length + 1, 1, oldRows - values.length, CONFIG_HEADERS.length).clearContent();
        }

        SpreadsheetApp.flush();
    } catch (e) {
        return _jsonResponse({ status: 'error', message: '儲存設定失敗 (' + e.message + ')' });
    } finally {
        lock.releaseLock();
    }
    return _jsonResponse({ status: 'saved' });
}


function _getDataSheet(ss) {
    var sheet = ss.getSheetByName("記帳資料");
    if (!sheet) {
        sheet = ss.insertSheet("記帳資料");
        sheet.appendRow(DATA_HEADERS);
        sheet.getRange(1, 1, 1, DATA_HEADERS.length).setFontWeight("bold").setBackground("#fcd34d").setHorizontalAlignment("center");
    }
    return sheet;
}

// 確保標題列有「類別ID」欄。只補標題，不會動到任何資料。
function _ensureDataHeaders(sheet) {
    if (sheet.getLastRow() === 0) {
        sheet.appendRow(DATA_HEADERS);
        sheet.getRange(1, 1, 1, DATA_HEADERS.length).setFontWeight("bold").setBackground("#fcd34d").setHorizontalAlignment("center");
        return;
    }
    if (sheet.getLastColumn() < DATA_HEADERS.length) {
        sheet.getRange(1, DATA_HEADERS.length).setValue(DATA_HEADERS[DATA_HEADERS.length - 1]);
        sheet.getRange(1, DATA_HEADERS.length).setFontWeight("bold").setBackground("#fcd34d").setHorizontalAlignment("center");
    }
}

function _jsonResponse(data) {
    return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}


// ==========================================================================
// 資料整理 (Migration)
// --------------------------------------------------------------------------
// 只做兩件事，且「只寫入空白的格子」：
//   1. 幫沒有編號的資料列補上 ID          → 解決刪除/修改會動到別筆的問題
//   2. 幫每一列補上「類別ID」              → 解決類別改名後花費消失的問題
//
// 絕對不會修改：登記時間、消費日期、月份、類別、項目、金額、備註
//
// 使用方式：
//   先跑 migrate_1_DryRun()  → 只印報告，不寫入任何東西
//   確認沒問題再跑 migrate_2_Apply()
//   兩者都可以重複執行，跑第二次不會重複處理。
// ==========================================================================

function migrate_1_DryRun() {
    _migrate(false);
}

function migrate_2_Apply() {
    _migrate(true);
}

function _migrate(apply) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = _getDataSheet(ss);
    var rows = sheet.getDataRange().getValues();

    Logger.log(apply ? '=== 正式執行 (會寫入) ===' : '=== 試算模式 (不會寫入任何東西) ===');
    Logger.log('記帳資料總列數 (不含標題): ' + Math.max(0, rows.length - 1));

    // --- 先掃描現況 ---
    var blankIds = [];
    var idCounts = {};
    var needCatId = [];
    var cannotResolve = [];
    var monthConfigCache = {};

    function configFor(month) {
        if (monthConfigCache[month]) return monthConfigCache[month];
        var cs = ss.getSheetByName("設定_" + month) || ss.getSheetByName("設定");
        var map = {};
        if (cs) {
            var cr = cs.getDataRange().getValues();
            for (var k = 1; k < cr.length; k++) {
                if (cr[k][C_ID] && map[cr[k][C_NAME]] === undefined) {
                    map[cr[k][C_NAME]] = String(cr[k][C_ID]);
                }
            }
        }
        monthConfigCache[month] = map;
        return map;
    }

    for (var i = 1; i < rows.length; i++) {
        var row = rows[i];
        // 完全空白的列直接跳過
        if (!row[D_DATE] && !row[D_CAT] && !row[D_AMOUNT]) continue;

        var id = String(row[D_ID] || '').trim();
        if (!id) {
            blankIds.push(i + 1);
        } else {
            idCounts[id] = (idCounts[id] || 0) + 1;
        }

        var catId = String(row[D_CATID] === undefined ? '' : row[D_CATID]).trim();
        if (!catId) {
            var month = _normMonth(row[D_MONTH]);
            var resolved = configFor(month)[row[D_CAT]];
            if (resolved) {
                needCatId.push({ rowNum: i + 1, catId: resolved });
            } else {
                cannotResolve.push({ rowNum: i + 1, month: month, name: String(row[D_CAT]) });
            }
        }
    }

    var dupIds = Object.keys(idCounts).filter(function (k) { return idCounts[k] > 1; });

    Logger.log('--- 現況 ---');
    Logger.log('沒有編號的列: ' + blankIds.length + ' 筆' + (blankIds.length ? '  (第 ' + blankIds.join(', ') + ' 列)' : ''));
    Logger.log('編號重複的: ' + dupIds.length + ' 組' + (dupIds.length ? '  ' + dupIds.join(', ') : ''));
    Logger.log('需要補類別ID的列: ' + needCatId.length + ' 筆');
    Logger.log('類別名稱在該月設定裡找不到、無法補的: ' + cannotResolve.length + ' 筆');

    if (cannotResolve.length) {
        var summary = {};
        cannotResolve.forEach(function (x) {
            var key = x.month + ' / ' + x.name;
            summary[key] = (summary[key] || 0) + 1;
        });
        Logger.log('   這些列會維持用「名稱」對帳 (跟現在行為一樣，不會變差):');
        Object.keys(summary).forEach(function (k) { Logger.log('     ' + k + '  ×' + summary[k]); });
    }

    if (!apply) {
        Logger.log('');
        Logger.log('以上都還沒寫入。確認沒問題後，請執行 migrate_2_Apply()');
        return;
    }

    // --- 正式寫入 ---
    var lock = LockService.getScriptLock();
    try {
        lock.waitLock(30000);
        _ensureDataHeaders(sheet);

        var stamp = Date.now();
        var wroteIds = 0, wroteCatIds = 0;

        // 補 ID：一次讀出整欄再一次寫回，避免逐格寫入太慢
        if (blankIds.length) {
            var idCol = sheet.getRange(2, D_ID + 1, rows.length - 1, 1).getValues();
            blankIds.forEach(function (rowNum, n) {
                idCol[rowNum - 2][0] = 'fix' + stamp + n;
                wroteIds++;
            });
            sheet.getRange(2, D_ID + 1, rows.length - 1, 1).setValues(idCol);
        }

        // 補類別ID
        if (needCatId.length) {
            var catCol = sheet.getRange(2, D_CATID + 1, rows.length - 1, 1).getValues();
            needCatId.forEach(function (x) {
                catCol[x.rowNum - 2][0] = x.catId;
                wroteCatIds++;
            });
            sheet.getRange(2, D_CATID + 1, rows.length - 1, 1).setValues(catCol);
        }

        SpreadsheetApp.flush();

        Logger.log('');
        Logger.log('--- 完成 ---');
        Logger.log('補上編號: ' + wroteIds + ' 筆');
        Logger.log('補上類別ID: ' + wroteCatIds + ' 筆');
        Logger.log('金額、日期、類別、項目、備註 完全沒有被修改。');
    } catch (e) {
        Logger.log('執行失敗: ' + e.message);
    } finally {
        lock.releaseLock();
    }
}


// ==========================================
// 測試用：在編輯器裡選這個函式按「執行」，用來觸發授權並檢查後端是否正常。
// ==========================================
function _testDoPost() {
    var token = _getConfig('APP_TOKEN');
    Logger.log('APP_TOKEN 是否已設定: ' + (token ? '是 (長度 ' + token.length + ')' : '否 ← 請先到專案設定新增'));
    Logger.log('OPENAI_API_KEY 是否已設定: ' + (_getConfig('OPENAI_API_KEY') ? '是' : '否 ← 請先到專案設定新增'));

    var fake = {
        postData: {
            contents: JSON.stringify({
                action: 'getData',
                month: '2026-05',
                token: token
            })
        }
    };

    var out = doPost(fake);
    Logger.log('後端回應: ' + out.getContent().substring(0, 800));
}
