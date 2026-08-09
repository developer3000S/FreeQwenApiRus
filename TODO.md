# TODO — Исправление ошибки `Runtime.callFunctionOn timed out` / `protocolTimeout`

## Шаги

- [x] 1. `src/api/chat.js` — добавить browser-side `AbortController` таймаут в in-page `fetch` в `executeApiRequest` (браузерный путь).
- [x] 2. `src/api/chat.js` — использовать существующий `evaluateWithProtocolGuard` для обёртки сырых `page.evaluate` вызовов.
- [x] 3. `src/api/chat.js` — в `catch` в `sendMessage` определять protocol-timeout ошибки и возвращать чистый retryable ответ.
- [x] 4. `src/api/fileUpload.js` — добавить browser-side `AbortController` таймаут в `getStsToken` и `uploadFile`.
- [x] 5. `.env.example` — задокументировать `PROTOCOL_TIMEOUT`, `BROWSER_FETCH_TIMEOUT`, `QWEN_USE_NODE_FETCH` (документация добавлена в `README.md`).
- [x] 6. Прогнать тесты `node --test tests/*.test.js` (60/60 прошли).
