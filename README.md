# FreeQwenApi — ForgetMeAI fork

> **Локальный OpenAI-compatible прокси к Qwen Chat** от [t.me/forgetmeai](https://t.me/forgetmeai).  
> Текст, модели Qwen 3.7, файлы, Open WebUI, Hermes/LiteLLM, а теперь ещё генерация изображений и видео через Qwen Chat.

![ForgetMeAI](https://img.shields.io/badge/ForgetMeAI-t.me%2Fforgetmeai-blue)
![API](https://img.shields.io/badge/API-OpenAI--compatible-green)
![Qwen](https://img.shields.io/badge/Qwen-Chat-purple)

## Что это такое

FreeQwenApi превращает веб-аккаунт Qwen Chat в локальный API endpoint:

```text
http://localhost:3264/api
```

Это **не локальная модель на вашей видеокарте** и **не официальный API Alibaba/Qwen**. Это практичный browser-based proxy: вы авторизуетесь в Qwen Chat, проект сохраняет сессию и даёт локальный OpenAI-compatible API для ваших инструментов.

## Возможности fork

- **Chat Completions API**: `POST /api/chat/completions`, совместимый с OpenAI SDK, Open WebUI, LiteLLM и агентами.
- **Актуальные модели Qwen Chat**: `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus` и другие модели из `src/AvailableModels.txt`.
- **Генерация изображений через Qwen Chat**: `POST /api/images/generations` без `DASHSCOPE_API_KEY`.
- **Генерация видео через Qwen Chat**: `POST /api/videos/generations` + polling задач через `GET /api/tasks/status/:taskId`.
- **Мультиаккаунты**: добавление, перелогин, удаление, статусы `OK` / `WAIT` / `INVALID`, автоматическая round-robin ротация при лимитах.
- **Загрузка файлов**: upload endpoint для файлов и вложений Qwen.
- **Open WebUI**: можно подключить как OpenAI-compatible backend.
- **Hermes Agent / OpenCode / Claude Code / Codex / OpenClaw / LiteLLM**: готовые инструкции для локальных AI-агентов и tool-use smoke-тестов.
- **Health/smoke tooling**: `/api/health`, `/api/status`, `/api/models`, `npm run smoke`, `npm run models:sync`.
- **ForgetMeAI branding**: watermark `t.me/forgetmeai` в README, CLI и health/media metadata.

## Быстрый старт

```bash
git clone https://github.com/ForgetMeAI/FreeQwenApi
cd FreeQwenApi
npm install
npm run auth
npm run models:sync
SKIP_ACCOUNT_MENU=true npm start
```

В другом терминале:

```bash
npm run smoke
```

Если всё хорошо, API доступен здесь:

```text
http://localhost:3264/api
```

## Настройка через `.env`

Проект автоматически читает `.env` из корня репозитория. Начните с примера:

```bash
cp .env.example .env
```

Самые полезные параметры для агентных клиентов:

- `QWEN_TOOL_PROMPT_MODE=minimal` — компактно встраивает OpenAI `tools` / `functions` в prompt. Это лучший режим для Hermes, OpenCode, Claude Code, Codex и OpenClaw.
- `QWEN_MAX_SYSTEM_CHARS=180000` — безопасный лимит для тяжёлых агентных клиентов с большими system prompt/tool schemas. Для обычного чата можно снизить, но OpenClaw/Claude Code/Codex лучше держать высоким.
- `QWEN_USE_NODE_FETCH=0` — оставляет запросы внутри browser `page.evaluate(fetch)`, что обычно лучше проходит Qwen anti-bot. Для отладки можно поставить `1`: ошибки anti-bot возвращаются быстрее и меньше Puppeteer-зависаний, но Node-side запросы чаще получают captcha.
- `NON_INTERACTIVE=1` и `SKIP_ACCOUNT_MENU=1` — запуск без меню аккаунтов для локальных агентов/демонов.

Полный список параметров с комментариями — в `.env.example`.

## Авторизация Qwen Chat

Добавить аккаунт:

```bash
npm run auth
```

Или сразу конкретное действие:

```bash
npm run auth -- --add
npm run auth -- --list
npm run auth -- --relogin
npm run auth -- --remove
```

При добавлении аккаунта откроется Chromium. Войдите в Qwen Chat, затем вернитесь в терминал — токен будет сохранён в `session/`.

**Не коммитьте и не публикуйте секреты:**

- `session/`
- `session/tokens.json`
- `session/accounts/**/token.txt`
- `.env`
- `Authorization.txt`
- cookies / browser profile / реальные токены

Proxy по умолчанию слушает только `127.0.0.1`. Для намеренного доступа из
сети задайте `HOST=0.0.0.0`, добавьте отдельные client keys в
`src/Authorization.txt` и перечислите точные browser-origin через
`CORS_ORIGINS=https://ui.example.com,http://192.168.1.20:3000`.

## Основные endpoints

### Health

```bash
curl http://localhost:3264/api/health
```

Ответ содержит количество моделей, аккаунтов и watermark:

```json
{
  "ok": true,
  "service": "FreeQwenApi",
  "watermark": "t.me/forgetmeai",
  "baseUrl": "/api",
  "models": 28
}
```

### Список моделей

```bash
curl http://localhost:3264/api/models
```

Обновить список моделей из Qwen Chat metadata:

```bash
npm run models:sync
```

Подробный отчёт: [docs/QWEN_CHAT_MODELS.md](docs/QWEN_CHAT_MODELS.md)

### Chat Completions

```bash
curl http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "messages": [
      {"role": "user", "content": "Ответь коротко: что такое FreeQwenApi?"}
    ],
    "stream": false
  }'
```

OpenAI SDK:

```js
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3264/api',
  apiKey: 'dummy-key'
});

const response = await openai.chat.completions.create({
  model: 'qwen3.7-max',
  messages: [{ role: 'user', content: 'Привет!' }]
});

console.log(response.choices[0].message.content);
```

## Генерация изображений через Qwen Chat

По умолчанию `/api/images/generations` использует **Qwen Chat**, а не DashScope. То есть отдельный `DASHSCOPE_API_KEY` не нужен — нужен активный Qwen Chat аккаунт.

```bash
curl http://localhost:3264/api/images/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Кинематографичный робот в неоновом Токио, стиль sci-fi poster",
    "model": "qwen3-vl-plus",
    "size": "16:9"
  }'
```

Пример ответа:

```json
{
  "created": 1770000000,
  "watermark": "t.me/forgetmeai",
  "provider": "qwen-chat",
  "model": "qwen3-vl-plus",
  "data": [
    { "url": "https://cdn.qwenlm.ai/.../image.png", "revised_prompt": "..." }
  ]
}
```

Поддерживаемые форматы `size` для Qwen Chat:

- `16:9`
- `9:16`
- `1:1`
- `4:3`
- также можно передать OpenAI-style `1024x1024`, `1792x1024`, `1024x1792` — они будут преобразованы в aspect ratio.

Старый DashScope-режим тоже оставлен:

```json
{
  "provider": "dashscope",
  "model": "qwen-image-plus",
  "prompt": "..."
}
```

Подробности: [IMAGE_VIDEO_GENERATION_GUIDE.md](IMAGE_VIDEO_GENERATION_GUIDE.md) и [docs/IMAGE_GENERATION.md](docs/IMAGE_GENERATION.md)

## Генерация видео через Qwen Chat

Создать видео и дождаться результата на сервере:

```bash
curl http://localhost:3264/api/videos/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Камера медленно приближается к футуристическому городу ночью, cinematic, 5 seconds",
    "model": "qwen3-vl-plus",
    "size": "16:9",
    "wait": true
  }'
```

Если не хотите держать HTTP-соединение открытым:

```bash
curl http://localhost:3264/api/videos/generations \
  -H "Content-Type: application/json" \
  -d '{
    "prompt": "Робот идёт под дождём в неоновом городе",
    "size": "16:9",
    "wait": false
  }'
```

Ответ вернёт `task_id`. Проверить статус:

```bash
curl http://localhost:3264/api/tasks/status/TASK_ID
```

Или подождать завершения прямо в status endpoint:

```bash
curl "http://localhost:3264/api/tasks/status/TASK_ID?wait=true"
```

## Open WebUI

Для локального Open WebUI:

```text
Base URL: http://localhost:3264/api
API Key: dummy-key
Model: qwen3.7-max
```

Если Open WebUI в Docker:

```text
Base URL: http://host.docker.internal:3264/api
API Key: dummy-key
```

Полная инструкция: [docs/OPENWEBUI_SETUP.md](docs/OPENWEBUI_SETUP.md)

## Агенты и tool-use: Hermes, OpenCode, Claude Code, Codex, OpenClaw

FreeQwenApi умеет не только обычный чат, но и agent/tool-use сценарии. Снаружи это выглядит как OpenAI/Anthropic-compatible tool calling, внутри tool schemas эмулируются через системный prompt для Qwen Chat.

Перед запуском агентных клиентов лучше поднять сервер так:

```bash
NON_INTERACTIVE=1 \
SKIP_ACCOUNT_MENU=1 \
HOST=127.0.0.1 \
PORT=3264 \
LOG_LEVEL=info \
QWEN_MAX_SYSTEM_CHARS=180000 \
QWEN_TOOL_PROMPT_MODE=minimal \
node index.js
```

Проверка OpenAI-compatible tool call напрямую:

```bash
curl http://127.0.0.1:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "stream": false,
    "messages": [{"role":"user","content":"Вызови инструмент write_file для smoke.js"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "write_file",
        "description": "Write a file",
        "parameters": {
          "type": "object",
          "properties": {
            "path": {"type":"string"},
            "content": {"type":"string"}
          },
          "required": ["path", "content"]
        }
      }
    }],
    "tool_choice": "auto"
  }'
```

Ожидаемый результат — `message.tool_calls` в non-streaming режиме или `delta.tool_calls` + `finish_reason: "tool_calls"` в streaming режиме.

### Hermes Agent

Hermes можно подключать как OpenAI-compatible custom provider.

```yaml
custom_providers:
  - name: qwen-free
    base_url: http://127.0.0.1:3264/api
    model: qwen3.7-max
    api_key: dummy-key
```

Готовый пример: [examples/hermes/config-snippet.yaml](examples/hermes/config-snippet.yaml)

Что поддерживается для Hermes:

- `/api/chat/completions` и `/api/v1/chat/completions` принимают `tools` / legacy `functions`;
- tool calls возвращаются как OpenAI `message.tool_calls` или streaming `delta.tool_calls`;
- продолжения с `role: "tool"` не ломают диалог: прокси сворачивает OpenAI transcript в понятный Qwen prompt;
- для длинных Hermes system prompt используйте `QWEN_MAX_SYSTEM_CHARS=180000`.

### OpenCode

Для одноразового smoke-теста не обязательно менять постоянный config OpenCode — можно передать provider через `OPENCODE_CONFIG_CONTENT`:

```bash
export OPENCODE_CONFIG_CONTENT='{
  "$schema":"https://opencode.ai/config.json",
  "provider": {
    "freeqwen": {
      "npm":"@ai-sdk/openai-compatible",
      "name":"FreeQwenApi",
      "options": {
        "baseURL":"http://127.0.0.1:3264/api",
        "apiKey":"dummy-key"
      },
      "models": {
        "qwen3.7-max": {"name":"qwen3.7-max"}
      }
    }
  }
}'

opencode run 'Create smoke.js, run it, and report output' \
  --model freeqwen/qwen3.7-max \
  --agent build \
  --print-logs
```

В успешном smoke OpenCode должен реально вызвать `write`/`bash`, а не просто ответить текстом.

### Claude Code

Claude Code требует Anthropic Messages API, поэтому FreeQwenApi отдаёт shim:

```text
POST /api/messages
POST /api/v1/messages
```

Запуск через локальный endpoint:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3264/api \
ANTHROPIC_API_KEY=dummy-key \
ANTHROPIC_AUTH_TOKEN=dummy-key \
ANTHROPIC_MODEL=qwen3.7-max \
CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1 \
claude --bare -p 'Create smoke.js, run npm run smoke, return the terminal output' \
  --model qwen3.7-max \
  --allowedTools 'Write,Bash' \
  --max-turns 8 \
  --output-format json
```

Под капотом shim конвертирует Anthropic `tools`, `tool_use` и `tool_result` в OpenAI-style историю и обратно.

### Codex CLI

Текущий Codex CLI больше не поддерживает `wire_api = "chat"`; используйте Responses API режим:

```toml
model = "qwen3.7-max"
model_provider = "freeqwen"
approval_policy = "never"
sandbox_mode = "workspace-write"

[model_providers.freeqwen]
name = "FreeQwenApi"
base_url = "http://127.0.0.1:3264/api"
wire_api = "responses"
experimental_bearer_token = "dummy-key"
```

Smoke:

```bash
CODEX_HOME=/path/to/codex-home \
codex exec 'Create smoke.js, create package.json with script smoke, run npm run smoke, return output' \
  --skip-git-repo-check
```

### OpenClaw

OpenClaw лучше запускать с большим контекстом — его system prompt и список tools заметно больше обычного.

Минимальная идея provider config:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "freeqwen": {
        "baseUrl": "http://127.0.0.1:3264/api",
        "apiKey": "dummy-key",
        "auth": "api-key",
        "api": "openai-completions",
        "contextWindow": 200000,
        "contextTokens": 180000,
        "maxTokens": 32000,
        "models": [
          {
            "id": "qwen3.7-max",
            "name": "qwen3.7-max",
            "api": "openai-completions",
            "contextTokens": 180000,
            "compat": {
              "supportsTools": true,
              "supportsStrictMode": false,
              "requiresStringContent": true,
              "strictMessageKeys": false,
              "maxTokensField": "max_tokens"
            }
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "freeqwen/qwen3.7-max"
    }
  }
}
```

Smoke:

```bash
openclaw --profile freeqwen-smoke agent \
  --local \
  --json \
  --model freeqwen/qwen3.7-max \
  --message 'Create smoke.js, run npm run smoke, return marker if successful' \
  --timeout 240
```

### LiteLLM bridge

Если нужен мост через LiteLLM:

```yaml
model_list:
  - model_name: qwen3.7-max
    litellm_params:
      model: openai/qwen3.7-max
      api_base: http://127.0.0.1:3264/api
      api_key: dummy-key
```

Готовый пример: [examples/litellm/qwen_litellm.yaml](examples/litellm/qwen_litellm.yaml)

### Важные caveats для агентов

- Это Qwen Chat web proxy, не официальный tool-calling API. Tool calls эмулируются prompt adapter’ом.
- Иногда Qwen web backend возвращает `chatId не существует`; обычно помогает повтор запроса или новый чат.
- При частых/длинных запросах возможен anti-bot/captcha challenge.
- Для OpenClaw/Codex/Claude Code держите `QWEN_MAX_SYSTEM_CHARS=180000`, иначе tool-инструкции могут обрезаться.
- Если агент пишет текст вместо вызова инструмента, проверьте, что клиент реально передал `tools`, а сервер запущен с `QWEN_TOOL_PROMPT_MODE=minimal`.

## Docker

Сначала добавьте аккаунт локально, потому что внутри контейнера нет GUI для входа:

```bash
npm run auth
```

Потом:

```bash
docker compose up --build -d
```

В `docker-compose.yml` важно пробросить `session/`:

```yaml
services:
  qwen-proxy:
    build: .
    environment:
      - SKIP_ACCOUNT_MENU=true
      - PORT=3264
    ports:
      - "3264:3264"
    volumes:
      - ./session:/app/session
      - ./logs:/app/logs
      - ./uploads:/app/uploads
```

## Рекомендуемые модели

- **Обычный чат / агенты**: `qwen3.7-max`
- **Быстрее и легче**: `qwen3.7-plus`
- **Кодинг**: `qwen3-coder-plus`
- **Изображения/видео через Qwen Chat**: `qwen3-vl-plus`
- **Open WebUI default**: `qwen3.7-max`

## Полезные команды

```bash
npm run auth                  # управление аккаунтами
npm run models:sync           # обновить список моделей
npm run smoke                 # быстрая проверка API
SKIP_ACCOUNT_MENU=true npm start
```

Проверки руками:

```bash
curl http://localhost:3264/api/health
curl http://localhost:3264/api/status
curl http://localhost:3264/api/models
curl http://localhost:3264/api/images/status
curl http://localhost:3264/api/videos/status
```

## Документация

- [docs/FORK_DEMO_QUICKSTART.md](docs/FORK_DEMO_QUICKSTART.md) — быстрый сценарий для демо/видео.
- [docs/QWEN_CHAT_MODELS.md](docs/QWEN_CHAT_MODELS.md) — отчёт синхронизации моделей Qwen Chat.
- [IMAGE_VIDEO_GENERATION_GUIDE.md](IMAGE_VIDEO_GENERATION_GUIDE.md) — генерация изображений и видео через `chatType`.
- [docs/IMAGE_GENERATION.md](docs/IMAGE_GENERATION.md) — DashScope/Qwen Image endpoints.
- [docs/OPENWEBUI_SETUP.md](docs/OPENWEBUI_SETUP.md) — подключение Open WebUI.
- [examples/hermes/config-snippet.yaml](examples/hermes/config-snippet.yaml) — Hermes Agent provider; см. раздел выше для OpenCode, Claude Code, Codex и OpenClaw.
- [examples/litellm/qwen_litellm.yaml](examples/litellm/qwen_litellm.yaml) — LiteLLM bridge.

## Ограничения

- Это неофициальный browser-based proxy, Qwen может менять внутренний API.
- Аккаунты Qwen Chat могут ловить лимиты; используйте несколько аккаунтов для round-robin.
- Привязка Qwen chat/task/file к аккаунту хранится только в памяти процесса и не сохраняет bearer-токены. После перезапуска неизвестный chatId безопасно заменяется новым чатом; при отправке полной OpenAI-истории прокси переносит её в новый чат. Приватные файлы нужно загрузить заново, а старый taskId нельзя опрашивать.
- Python entrypoint не принимает файловые вложения Qwen, потому что не может безопасно проверить аккаунт-владельца файла. Для upload и отправки файлов используйте Node.js entrypoint.
- Токены истекают — используйте `npm run auth -- --relogin`.
- Генерация фото/видео зависит от доступности функций Qwen Chat на конкретном аккаунте.
- URL сгенерированных медиа могут быть временными.
- Для production используйте осторожно: это инструмент для экспериментов, демо и локальных workflow.

## От ForgetMeAI

Если fork помог — подпишитесь: [t.me/forgetmeai](https://t.me/forgetmeai)

Там практичные AI-инструменты, локальные агенты, open-source находки и честные тесты без корпоративной лапши.
