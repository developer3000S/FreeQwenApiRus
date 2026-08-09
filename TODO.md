# TODO — Исправление зависания запроса /api/chat/completions

## Задача
Запрос к `/api/chat/completions` (stream:false) зависает бесконечно.
Причина: браузерные fetch-вызовы к Qwen API не имеют гарантированных таймаутов
(AbortController), установленных ДО начала `fetch`.

## План
- [x] 1. Browser-версия `executeApiRequest`: установить overallTimer и armIdleTimer() ДО `await fetch(...)`.
- [x] 2. `createChatV2`: добавить AbortController + таймаут перед `fetch`.
- [x] 3. `testToken`: добавить AbortController + таймаут перед `fetch`.
- [x] 4. `pollTaskStatus` (браузерный fetch): добавить таймаут (AbortController).
- [x] 5. Проверить изменения (логотипы/редактура) и запустить smoke-тест (npm test — 60/60 успешно).
