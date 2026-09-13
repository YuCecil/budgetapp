(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.BudgetApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
    'use strict';

    // 這兩種操作不會改動資料，遇到 Google 重新導向的異常回應時可以安全重試。
    const SAFE_RETRY_ACTIONS = new Set(['getData', 'analyze']);

    const makeError = (message, code, retryable) => {
        const error = new Error(message);
        error.code = code;
        error.retryable = !!retryable;
        return error;
    };

    const createRequestUrl = (baseUrl, action, nonce) => {
        const separator = baseUrl.includes('?') ? '&' : '?';
        const requestNonce = nonce || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        return `${baseUrl}${separator}action=${encodeURIComponent(action)}&_=${encodeURIComponent(requestNonce)}`;
    };

    const parseResponseText = (rawText) => {
        const text = String(rawText == null ? '' : rawText).trim();

        // doGet 的健康檢查內容。POST 偶爾被 Google 的重新導向誤導到這裡。
        if (text.startsWith('API is running.')) {
            throw makeError('Google 伺服器暫時把請求誤當成連線檢查，請再試一次', 'wrong_method_response', true);
        }
        if (!text) {
            throw makeError('伺服器沒有回傳內容，請再試一次', 'empty_response', true);
        }

        try {
            return JSON.parse(text);
        } catch (error) {
            throw makeError('伺服器回傳格式錯誤，請再試一次', 'invalid_json', true);
        }
    };

    const requestJson = async ({ baseUrl, action, payload, timeoutMs, fetchImpl }) => {
        const requestFetch = fetchImpl || root.fetch;
        if (typeof requestFetch !== 'function') throw makeError('瀏覽器不支援網路請求', 'fetch_unavailable', false);

        const maxAttempts = SAFE_RETRY_ACTIONS.has(action) ? 2 : 1;
        let lastError;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);

            try {
                const response = await requestFetch(createRequestUrl(baseUrl, action), {
                    method: 'POST',
                    mode: 'cors',
                    redirect: 'follow',
                    cache: 'no-store',
                    credentials: 'omit',
                    referrerPolicy: 'no-referrer',
                    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });

                if (!response.ok) {
                    throw makeError(`網路連線錯誤（HTTP ${response.status}）`, 'http_error', response.status >= 500);
                }
                return parseResponseText(await response.text());
            } catch (error) {
                if (error && error.name === 'AbortError') {
                    lastError = makeError(`連線逾時（超過 ${timeoutMs / 1000} 秒沒有回應），請確認網路後再試一次`, 'timeout', false);
                } else if (error && error.code) {
                    lastError = error;
                } else {
                    lastError = makeError('連不上伺服器，請確認網路後再試一次', 'network_error', true);
                }

                if (attempt >= maxAttempts || !lastError.retryable) throw lastError;
            } finally {
                clearTimeout(timer);
            }
        }

        throw lastError;
    };

    return {
        SAFE_RETRY_ACTIONS,
        createRequestUrl,
        parseResponseText,
        requestJson
    };
});
