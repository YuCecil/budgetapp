const assert = require('assert');
const BudgetApi = require('../frontend-api.js');

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const jsonResponse = value => ({
    ok: true,
    status: 200,
    text: async () => typeof value === 'string' ? value : JSON.stringify(value)
});

test('請求網址每次帶防快取參數，且不洩漏通行碼', () => {
    const url = BudgetApi.createRequestUrl('https://example.test/exec', 'analyze', 'fixed-nonce');
    assert.equal(url, 'https://example.test/exec?action=analyze&_=fixed-nonce');
    assert(!url.includes('secret-token'));
});

test('原網址已有參數時會正確接上新參數', () => {
    const url = BudgetApi.createRequestUrl('https://example.test/exec?x=1', 'getData', 'n');
    assert.equal(url, 'https://example.test/exec?x=1&action=getData&_=n');
});

test('AI 分析遇到 doGet 健康檢查回應會安全重試一次', async () => {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        return calls.length === 1
            ? jsonResponse('API is running.')
            : jsonResponse({ status: 'success', data: { transactions: [] } });
    };

    const result = await BudgetApi.requestJson({
        baseUrl: 'https://example.test/exec',
        action: 'analyze',
        payload: { action: 'analyze', token: 'secret-token' },
        timeoutMs: 1000,
        fetchImpl
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.method, 'POST');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[0].options.credentials, 'omit');
    assert(!calls[0].url.includes('secret-token'));
    assert.equal(JSON.parse(calls[0].options.body).token, 'secret-token');
    assert.equal(result.status, 'success');
});

test('寫入遇到異常回應不自動重送，避免重複記帳', async () => {
    let calls = 0;
    await assert.rejects(
        BudgetApi.requestJson({
            baseUrl: 'https://example.test/exec',
            action: 'addData',
            payload: { action: 'addData', token: 'secret-token' },
            timeoutMs: 1000,
            fetchImpl: async () => {
                calls++;
                return jsonResponse('API is running.');
            }
        }),
        error => error.code === 'wrong_method_response'
    );
    assert.equal(calls, 1);
});

test('非 JSON 回應會顯示可理解的錯誤', () => {
    assert.throws(
        () => BudgetApi.parseResponseText('<html>temporary error</html>'),
        error => error.code === 'invalid_json' && /格式錯誤/.test(error.message)
    );
});

(async () => {
    let passed = 0;
    for (const { name, fn } of tests) {
        try {
            await fn();
            passed++;
            console.log(`✓ ${name}`);
        } catch (error) {
            console.error(`✗ ${name}`);
            console.error(error);
            process.exitCode = 1;
        }
    }
    console.log(`\nFrontend API: ${passed}/${tests.length} passed`);
})();
