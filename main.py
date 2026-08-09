import os
import json
import time
import uuid
import asyncio
import sys
import logging
import copy
import hashlib
import secrets
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any, Union

import httpx
import uvicorn
from fastapi import FastAPI, Request, Response, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from playwright.async_api import async_playwright
from pydantic import BaseModel
from dotenv import load_dotenv

from python_affinity import ChatAffinityRegistry, StripedAsyncLockPool

# Загружаем переменные окружения из .env
load_dotenv()

# =================================================================
# CONFIGURATION & CONSTANTS
# =================================================================
PORT = int(os.environ.get("PORT", 3264))
HOST = os.environ.get("HOST", "127.0.0.1")
QWEN_BASE_URL = "https://chat.qwen.ai"
CHAT_PAGE_URL = f"{QWEN_BASE_URL}/"
CHAT_API_URL = f"{QWEN_BASE_URL}/api/v2/chat/completions"
CREATE_CHAT_URL = f"{QWEN_BASE_URL}/api/v2/chats/new"
SESSION_DIR = "session"
TOKENS_FILE = os.path.join(SESSION_DIR, "tokens.json")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "qwen3.7-max")
AVAILABLE_MODELS_FILE = os.path.join("src", "AvailableModels.txt")
AUTH_KEYS_FILE = os.path.join("src", "Authorization.txt")

# =================================================================
# MODEL MAPPING (Embedded for standalone usage)
# =================================================================
MODEL_MAPPING = {
    "qwen3.5": "qwen3.5-plus",
    "qwen-max": "qwen3-max",
    "qwen-vl": "qwen3-vl-plus",
    "qwen-coder": "qwen3-coder-plus",
    "qwen3": "qwen3-235b-a22b",
    "qwq": "qwq-32b",
    "qvq": "qvq-72b-preview-0310",
    # ... more mappings can be added here
}

def get_mapped_model(model_name: str) -> str:
    return MODEL_MAPPING.get(model_name.lower(), model_name)

def load_available_models() -> List[str]:
    models = set(MODEL_MAPPING.keys())
    models.add(DEFAULT_MODEL)
    if os.path.exists(AVAILABLE_MODELS_FILE):
        try:
            with open(AVAILABLE_MODELS_FILE, "r", encoding="utf-8") as f:
                for line in f:
                    value = line.strip()
                    if value and not value.startswith("#"):
                        models.add(value)
        except Exception as e:
            logger.warning(f"Не удалось загрузить список моделей из {AVAILABLE_MODELS_FILE}: {e}")
    return sorted(models)

# =================================================================
# LOGGING
# =================================================================
logging.basicConfig(level=logging.DEBUG, format='[%(asctime)s] [%(levelname)s] %(message)s', datefmt='%H:%M:%S')
logger = logging.getLogger("FreeQwenApi")

# TOKEN MANAGEMENT
# =================================================================
def ensure_session_dir():
    if not os.path.exists(SESSION_DIR):
        os.makedirs(SESSION_DIR, exist_ok=True)

def load_tokens():
    ensure_session_dir()
    if not os.path.exists(TOKENS_FILE):
        return []
    try:
        with open(TOKENS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        logger.error(f"Ошибка загрузки tokens.json: {e}")
        return []

def save_tokens(tokens):
    ensure_session_dir()
    try:
        with open(TOKENS_FILE, "w", encoding="utf-8") as f:
            json.dump(tokens, f, indent=2, ensure_ascii=False)
    except Exception as e:
        logger.error(f"Ошибка сохранения tokens.json: {e}")

def _token_account_id(token_obj: Dict[str, Any]) -> Optional[str]:
    configured_id = str(token_obj.get("id") or "").strip()
    if configured_id:
        return configured_id
    token = str(token_obj.get("token") or "").strip()
    if not token:
        return None
    digest = hashlib.sha256(token.encode("utf-8")).hexdigest()[:20]
    return f"token:{digest}"


def _is_token_available(token_obj: Dict[str, Any], now_ms: Optional[float] = None) -> bool:
    if not isinstance(token_obj, dict) or token_obj.get("invalid") or not token_obj.get("token"):
        return False
    reset_at = token_obj.get("resetAt")
    if not reset_at:
        return True
    try:
        reset_timestamp = datetime.fromisoformat(str(reset_at).replace("Z", "+00:00")).timestamp() * 1000
    except (TypeError, ValueError):
        return False
    return reset_timestamp <= (now_ms if now_ms is not None else time.time() * 1000)


def _snapshot_token(token_obj: Dict[str, Any]) -> Dict[str, Any]:
    """Detach a request's credentials from later token-file mutations."""
    return copy.deepcopy(token_obj)


def _available_tokens() -> List[Dict[str, Any]]:
    tokens = load_tokens()
    now = time.time() * 1000
    return [token for token in tokens if _is_token_available(token, now)]


_pointer = 0
def get_available_token(excluded_account_ids=None, excluded_token_values=None):
    excluded_ids = set(excluded_account_ids or ())
    excluded_values = set(excluded_token_values or ())
    valid = [
        token
        for token in _available_tokens()
        if _token_account_id(token) not in excluded_ids and token.get("token") not in excluded_values
    ]
    if not valid:
        return None
    global _pointer
    token_obj = valid[_pointer % len(valid)]
    _pointer = (_pointer + 1) % len(valid)
    return _snapshot_token(token_obj)


def get_available_token_by_id(account_id: str):
    normalized_id = str(account_id or "").strip()
    if not normalized_id:
        return None
    for token_obj in _available_tokens():
        if _token_account_id(token_obj) == normalized_id:
            return _snapshot_token(token_obj)
    return None


def _mark_token_state(token_obj: Dict[str, Any], *, invalid=False, reset_at=None):
    account_id = _token_account_id(token_obj)
    bearer = token_obj.get("token")
    tokens = load_tokens()
    changed = False
    for stored in tokens:
        same_account = account_id is not None and _token_account_id(stored) == account_id
        same_bearer = bool(bearer) and stored.get("token") == bearer
        if not (same_account or same_bearer):
            continue
        if invalid:
            stored["invalid"] = True
        if reset_at is not None:
            stored["resetAt"] = reset_at
        changed = True
    if changed:
        save_tokens(tokens)


def mark_invalid_token(token_obj: Dict[str, Any]):
    _mark_token_state(token_obj, invalid=True)


def mark_rate_limited_token(token_obj: Dict[str, Any], hours=24):
    reset_time = datetime.fromtimestamp(time.time() + hours * 3600, tz=timezone.utc)
    _mark_token_state(token_obj, reset_at=reset_time.isoformat().replace("+00:00", "Z"))

def mark_rate_limited(token_id, hours=24):
    token_obj = next(
        (token for token in load_tokens() if _token_account_id(token) == str(token_id)),
        None,
    )
    if token_obj is not None:
        mark_rate_limited_token(token_obj, hours)

# =================================================================
# AUTH & BROWSER (Playwright)
# =================================================================
async def login_interactive(email=None, password=None, headless=False):
    """Интерактивный вход через браузер для получения токена"""
    logger.info("Запуск браузера для авторизации (headless=%s)...", headless)
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=headless)
        context = await browser.new_context()
        page = await context.new_page()
        
        # Переходим на страницу авторизации (signin)
        auth_url = f"{QWEN_BASE_URL}/auth?action=signin"
        await page.goto(auth_url)
        
        if email and password:
            try:
                # Ожидаем появления формы входа
                await page.wait_for_selector('input[type="text"], input[type="email"], #username', timeout=15000)
                await page.fill('input[type="text"], input[type="email"], #username', email)
                await page.keyboard.press("Enter")
                await asyncio.sleep(3)
                await page.wait_for_selector('input[type="password"], #password', timeout=10000)
                await page.fill('input[type="password"], #password', password)
                await page.keyboard.press("Enter")
            except Exception as e:
                logger.warning(f"Автоматический ввод не удался: {e}. Пожалуйста, войдите вручную в браузере.")

        print("\n" + "="*50)
        print("               АВТОРИЗАЦИЯ")
        print("="*50)
        print("1. Войдите в свой аккаунт Qwen в открытом окне браузера.")
        print("2. Дождитесь появления интерфейса чата.")
        print("3. Нажмите Enter здесь для завершения.")
        print("="*50)
        
        input("\nНажмите Enter после успешного входа...")
        
        token = None
        try:
            token = await page.evaluate("localStorage.getItem('token')")
        except Exception as e:
            logger.error(f"Не удалось получить токен: {e}")
            await browser.close()
            return
        if not token:
            logger.error("Токен не найден! Убедитесь, что вы вошли в систему.")
            await browser.close()
            return

        user_info_raw = await page.evaluate("localStorage.getItem('user_info')")
        account_name = email
        if user_info_raw:
            try:
                user_info = json.loads(user_info_raw)
                account_name = user_info.get('email') or user_info.get('nickname') or account_name
            except: pass
            
        if not account_name:
            try:
                account_name = await page.evaluate("document.querySelector('.user-name, .email')?.innerText || ''")
            except: pass
            
        # Если всё еще нет имени, генерируем автоматически как в Node JS
        if not account_name:
            account_name = f"acc_{int(time.time() * 1000)}"
            logger.info(f"Имя аккаунта не определено, используем ID: {account_name}")
            
        # Извлекаем все куки из сессии браузера
        cookies = await context.cookies()
        
        tokens = load_tokens()
        tokens = [t for t in tokens if t['id'] != account_name]
        tokens.append({
            "id": account_name,
            "token": token,
            "cookies": cookies,  # Сохраняем куки
            "added_at": datetime.now().isoformat(),
            "invalid": False,
            "resetAt": None
        })
        save_tokens(tokens)
        logger.info(f"Аккаунт {account_name} успешно добавлен!")
        await browser.close()

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    "Origin": QWEN_BASE_URL,
    "Referer": CHAT_PAGE_URL,
}

# =================================================================
# CORE PROXY ENGINE
# =================================================================
_chat_affinity = ChatAffinityRegistry(max_entries=10_000)
_chat_request_locks = StripedAsyncLockPool(stripes=257)


def _load_proxy_api_keys() -> Optional[List[str]]:
    if not os.path.exists(AUTH_KEYS_FILE):
        return []
    try:
        with open(AUTH_KEYS_FILE, "r", encoding="utf-8") as auth_file:
            return [
                line.strip()
                for line in auth_file
                if line.strip() and not line.lstrip().startswith("#")
            ]
    except OSError as exc:
        logger.error("Не удалось прочитать файл proxy API keys: %s", exc)
        return None


def _build_proxy_client_scope(
    ip: Optional[str],
    user_agent: Optional[str],
    credential_fingerprint: Optional[str] = None,
) -> str:
    identity = "||".join((
        str(ip or "unknown"),
        str(user_agent or "unknown"),
        str(credential_fingerprint or "public"),
    ))
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def _authorize_proxy_request(request: Request):
    configured_keys = _load_proxy_api_keys()
    if configured_keys is None:
        return None, JSONResponse(status_code=503, content={"error": "Proxy authorization is unavailable"})
    credential_fingerprint = None
    if configured_keys:
        authorization = str(request.headers.get("authorization") or "")
        if not authorization.startswith("Bearer "):
            return None, JSONResponse(status_code=401, content={"error": "Требуется авторизация"})
        bearer = authorization[7:].strip()
        if not bearer or not any(secrets.compare_digest(bearer, key) for key in configured_keys):
            return None, JSONResponse(status_code=401, content={"error": "Недействительный токен"})
        # Only this one-way digest survives the request boundary.
        credential_fingerprint = hashlib.sha256(bearer.encode("utf-8")).hexdigest()

    client = getattr(request, "client", None)
    ip = getattr(client, "host", None)
    user_agent = request.headers.get("user-agent")
    return _build_proxy_client_scope(ip, user_agent, credential_fingerprint), None


def _scope_external_chat_id(chat_id: Optional[str], client_scope: Optional[str]) -> Optional[str]:
    normalized_chat_id = str(chat_id or "").strip()
    normalized_scope = str(client_scope or "").strip()
    if not normalized_chat_id:
        return None
    if not normalized_scope:
        return normalized_chat_id
    digest = hashlib.sha256(
        f"python-client-chat:{normalized_scope}:{normalized_chat_id}".encode("utf-8")
    ).hexdigest()[:20]
    return f"chat_{digest}"


def _new_account_http_client(token_obj: Dict[str, Any]) -> httpx.AsyncClient:
    cookies = httpx.Cookies()
    for cookie in token_obj.get("cookies") or []:
        if not isinstance(cookie, dict) or not cookie.get("name"):
            continue
        cookies.set(
            cookie["name"],
            str(cookie.get("value") or ""),
            domain=str(cookie.get("domain") or ""),
            path=str(cookie.get("path") or "/"),
        )
    return httpx.AsyncClient(
        timeout=120.0,
        follow_redirects=True,
        cookies=cookies,
    )


async def _create_qwen_chat_result(token_obj, model=DEFAULT_MODEL, client=None):
    """Create a chat and retain upstream status for safe account failover."""
    token = token_obj['token']
    owns_client = client is None
    account_client = client or _new_account_http_client(token_obj)

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "Accept": "*/*",
        "User-Agent": DEFAULT_HEADERS["User-Agent"],
        "Accept-Language": DEFAULT_HEADERS["Accept-Language"],
        "Origin": QWEN_BASE_URL,
        "Referer": CHAT_PAGE_URL,
    }
    payload = {
        "title": "Новый чат",
        "models": [model],
        "chat_mode": "normal",
        "chat_type": "t2t",
        "timestamp": int(time.time() * 1000)
    }
    try:
        resp = await account_client.post(CREATE_CHAT_URL, headers=headers, json=payload, timeout=30.0)
        if resp.status_code == 200:
            content_type = resp.headers.get("content-type", "")
            if "application/json" not in content_type:
                logger.error(f"Получен неожиданный контент ({content_type}) вместо JSON. Тело: {resp.text[:500]}")
                return {
                    "success": False,
                    "status": 500,
                    "error": "Unexpected create-chat response",
                    "details": resp.text[:500],
                }
            try:
                data = resp.json()
                structured_error = _parse_qwen_error_json(data)
                if structured_error:
                    structured_error["success"] = False
                    return structured_error
                chat_id = data.get('data', {}).get('id')
                if chat_id:
                    return {"success": True, "chat_id": str(chat_id)}
                return {
                    "success": False,
                    "status": 500,
                    "error": "Qwen did not return a chat id",
                }
            except Exception as je:
                logger.error(f"Ошибка парсинга JSON: {je}. Тело: {resp.text[:500]}")
                return {
                    "success": False,
                    "status": 500,
                    "error": "Invalid create-chat JSON",
                    "details": resp.text[:500],
                }
        else:
            logger.error(f"Ошибка создания чата: {resp.status_code}, тело: {resp.text[:500]}")
            return {
                "success": False,
                "status": resp.status_code,
                "error": "Ошибка создания чата",
                "details": resp.text[:500],
            }
    except Exception as e:
        logger.error(f"Исключение при создании чата: {e}")
        return {
            "success": False,
            "status": 500,
            "error": "Proxy error while creating chat",
            "details": str(e),
        }
    finally:
        if owns_client:
            await account_client.aclose()


async def create_qwen_chat(token_obj, model=DEFAULT_MODEL):
    """Backward-compatible chat creation helper."""
    result = await _create_qwen_chat_result(token_obj, model)
    return result.get("chat_id") if result.get("success") else None

def build_qwen_payload(message_content, model, chat_id, parent_id=None, system_message=None, files=None):
    user_msg_id = str(uuid.uuid4())
    assistant_msg_id = str(uuid.uuid4())
    
    # Структура сообщения должна точно соответствовать API v2
    new_message = {
        "fid": user_msg_id,
        "parentId": parent_id,
        "parent_id": parent_id,
        "role": "user",
        "content": message_content,
        "chat_type": "t2t",
        "sub_chat_type": "t2t",
        "timestamp": int(time.time()),
        "user_action": "chat",
        "models": [model],
        "files": files or [],
        "childrenIds": [assistant_msg_id],
        "extra": {"meta": {"subChatType": "t2t"}},
        "feature_config": {"thinking_enabled": False, "output_schema": "phase"}
    }
    
    payload = {
        # Для t2t-запросов Qwen API стабильнее работает через SSE-stream,
        # даже если клиент запросил нестриминговый OpenAI-ответ.
        "stream": True,
        "incremental_output": True,
        "chat_id": chat_id,
        "chat_mode": "normal",
        "messages": [new_message],
        "model": model, 
        "parent_id": parent_id,
        "timestamp": int(time.time())
    }
    
    if system_message:
        payload["system_message"] = system_message
    return payload

def _normalize_message_content(content):
    if not isinstance(content, list):
        return content

    normalized = []
    for item in content:
        if not isinstance(item, dict):
            normalized.append(item)
            continue

        item_type = item.get("type")
        if item_type == "text" and isinstance(item.get("text"), str):
            normalized.append({"type": "text", "text": item["text"]})
            continue
        if item_type == "image_url" and isinstance(item.get("image_url"), dict):
            image_url = item["image_url"].get("url")
            if image_url:
                normalized.append({"type": "image", "image": image_url})
                continue
        if item_type == "image" and isinstance(item.get("image"), str):
            normalized.append({"type": "image", "image": item["image"]})
            continue
        if item_type == "file" and isinstance(item.get("file"), str):
            normalized.append({"type": "file", "file": item["file"]})
            continue

        normalized.append(item)

    return normalized

def _extract_messages(body: Dict[str, Any]) -> List[Dict[str, Any]]:
    messages = body.get("messages")
    if isinstance(messages, list) and messages:
        return messages

    if body.get("message") is not None:
        return [{"role": "user", "content": body.get("message")}]

    return []

def _extract_chat_ids(body: Dict[str, Any]):
    chat_id = body.get("chatId") or body.get("chat_id")
    parent_id = body.get("parentId") or body.get("parent_id") or body.get("x_qwen_parent_id")
    return chat_id, parent_id

def _build_openai_completion(content: str, model: str, chat_id: Optional[str], parent_id: Optional[str], usage: Optional[Dict[str, Any]] = None):
    return {
        "id": f"chatcmpl-{uuid.uuid4()}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop"
        }],
        "usage": usage or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        "chatId": chat_id,
        "parentId": parent_id
    }

def _parse_qwen_error_json(parsed: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    top_code = parsed.get("code")
    nested_data = parsed.get("data") if isinstance(parsed.get("data"), dict) else {}
    nested_code = nested_data.get("code")
    has_error = (
        parsed.get("success") is False or
        bool(parsed.get("error")) or
        bool(nested_data.get("error")) or
        bool(top_code) or
        bool(nested_code)
    )
    if not has_error:
        return None

    normalized_codes = {
        str(code).strip().lower()
        for code in (top_code, nested_code)
        if code is not None
    }
    is_rate_limited = any(
        code in {"ratelimited", "rate_limited", "too_many_requests", "429"}
        for code in normalized_codes
    )
    is_unauthorized = any(
        code in {"unauthorized", "unauthenticated", "invalidtoken", "invalid_token", "401"}
        for code in normalized_codes
    )
    return {
        "status": 429 if is_rate_limited else (401 if is_unauthorized else 500),
        "error": "Ошибка Qwen API",
        "details": json.dumps(parsed, ensure_ascii=False)
    }

async def execute_qwen_completion(token_obj, chat_id, payload, on_chunk=None, client=None):
    token = token_obj["token"]
    owns_client = client is None
    account_client = client or _new_account_http_client(token_obj)

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {token}",
        "Accept": "*/*",
        "User-Agent": DEFAULT_HEADERS["User-Agent"],
        "Accept-Language": DEFAULT_HEADERS["Accept-Language"],
        "Origin": QWEN_BASE_URL,
        "Referer": f"{QWEN_BASE_URL}/c/{chat_id}",
    }

    logger.debug(f"Отправка запроса в чат {chat_id}...")
    try:
        async with account_client.stream(
            "POST",
            f"{CHAT_API_URL}?chat_id={chat_id}",
            headers=headers,
            json=payload,
            timeout=120.0
        ) as response:
            actual_status_raw = response.headers.get("x-actual-status-code")
            try:
                actual_status = int(actual_status_raw) if actual_status_raw else None
            except Exception:
                actual_status = None

            effective_status = (
                actual_status
                if actual_status is not None and actual_status >= 400
                else response.status_code
            )
            if effective_status != 200:
                body = (await response.aread()).decode("utf-8", errors="ignore")
                return {
                    "success": False,
                    "status": effective_status,
                    "error": "Ошибка Qwen API",
                    "details": body
                }

            content_type = (response.headers.get("content-type") or "").lower()
            if "text/event-stream" not in content_type:
                body = (await response.aread()).decode("utf-8", errors="ignore")
                try:
                    parsed = json.loads(body)
                except Exception:
                    return {
                        "success": False,
                        "status": actual_status or 500,
                        "error": "Unexpected non-SSE 200 response",
                        "details": body
                    }

                structured_error = _parse_qwen_error_json(parsed)
                if structured_error:
                    if actual_status and actual_status >= 400:
                        structured_error["status"] = actual_status
                    structured_error["success"] = False
                    return structured_error

                content = ""
                choices = parsed.get("choices")
                if isinstance(choices, list) and choices:
                    first_choice = choices[0] if isinstance(choices[0], dict) else {}
                    msg = first_choice.get("message") if isinstance(first_choice.get("message"), dict) else {}
                    content = str(msg.get("content") or "")
                elif parsed.get("success") is True and isinstance(parsed.get("data"), dict):
                    content = str(parsed["data"].get("content") or "")

                if content and callable(on_chunk):
                    on_chunk(content)

                return {
                    "success": True,
                    "content": content,
                    "response_id": parsed.get("response_id") or parsed.get("id"),
                    "usage": parsed.get("usage") or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
                }

            full_content = ""
            response_id = None
            usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
            finished = False

            async for raw_line in response.aiter_lines():
                line = raw_line.strip()
                if not line or not line.startswith("data:"):
                    continue

                data_str = line[5:].strip()
                if not data_str:
                    continue
                if data_str == "[DONE]":
                    break

                try:
                    chunk = json.loads(data_str)
                except Exception:
                    continue

                chunk_code = str(chunk.get("code") or "").strip().lower()
                if chunk_code in {"ratelimited", "rate_limited", "too_many_requests", "429"}:
                    return {
                        "success": False,
                        "status": 429,
                        "error": "RateLimited",
                        "details": json.dumps(chunk, ensure_ascii=False),
                        "has_streamed_chunks": bool(full_content),
                    }
                if chunk_code in {"unauthorized", "unauthenticated", "invalidtoken", "invalid_token", "401"}:
                    return {
                        "success": False,
                        "status": 401,
                        "error": "Unauthorized",
                        "details": json.dumps(chunk, ensure_ascii=False),
                        "has_streamed_chunks": bool(full_content),
                    }
                if chunk.get("error") and not chunk.get("choices"):
                    return {
                        "success": False,
                        "status": 500,
                        "error": "Ошибка Qwen API",
                        "details": json.dumps(chunk, ensure_ascii=False),
                        "has_streamed_chunks": bool(full_content),
                    }

                created_meta = chunk.get("response.created")
                if isinstance(created_meta, dict) and created_meta.get("response_id"):
                    response_id = created_meta["response_id"]
                if chunk.get("response_id"):
                    response_id = chunk["response_id"]

                chunk_usage = chunk.get("usage")
                if isinstance(chunk_usage, dict):
                    usage = chunk_usage

                choices = chunk.get("choices")
                if not isinstance(choices, list) or not choices:
                    continue

                first_choice = choices[0] if isinstance(choices[0], dict) else {}
                delta = first_choice.get("delta") if isinstance(first_choice.get("delta"), dict) else {}
                piece = delta.get("content")
                if piece is not None:
                    piece_str = str(piece)
                    full_content += piece_str
                    if callable(on_chunk):
                        on_chunk(piece_str)

                if delta.get("status") == "finished" or first_choice.get("finish_reason"):
                    finished = True
                    break

            return {
                "success": True,
                "content": full_content,
                "response_id": response_id,
                "usage": usage,
                "finished": finished
            }

    except Exception as e:
        logger.error(f"Ошибка запроса к Qwen API: {e}")
        return {
            "success": False,
            "status": 500,
            "error": "Proxy error",
            "details": str(e)
        }
    finally:
        if owns_client:
            await account_client.aclose()


def _message_content_as_transcript_text(content: Any) -> str:
    normalized = _normalize_message_content(content)
    if isinstance(normalized, str):
        return normalized
    if normalized is None:
        return ""
    if isinstance(normalized, list):
        parts = []
        for item in normalized:
            if isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
            elif isinstance(item, dict) and item.get("type") == "image":
                parts.append(f"[image: {item.get('image') or ''}]")
            elif isinstance(item, dict) and item.get("type") == "file":
                parts.append(f"[file: {item.get('file') or ''}]")
            else:
                parts.append(json.dumps(item, ensure_ascii=False))
        return "\n".join(part for part in parts if part)
    if isinstance(normalized, (dict, tuple)):
        return json.dumps(normalized, ensure_ascii=False)
    return str(normalized)


def _build_stateless_transcript(messages: List[Dict[str, Any]]) -> Optional[str]:
    """Fold OpenAI history into one user turn when a fresh Qwen chat is required."""
    conversation_messages = [
        message
        for message in messages
        if isinstance(message, dict) and message.get("role") != "system"
    ]
    if len(conversation_messages) <= 1:
        return None

    blocks = []
    for message in conversation_messages:
        role = str(message.get("role") or "user").upper()
        content = _message_content_as_transcript_text(message.get("content"))
        blocks.append(f"[{role}]\n{content}")
    return (
        "The upstream chat was recreated. Continue the conversation using this "
        "complete transcript:\n\n" + "\n\n".join(blocks)
    )


def _contains_account_bound_file(value: Any) -> bool:
    if isinstance(value, list):
        return any(_contains_account_bound_file(item) for item in value)
    if not isinstance(value, dict):
        return False
    if value.get("type") in {"file", "input_file"}:
        return True
    if any(value.get(key) for key in ("file", "file_id", "fileId", "file_path", "file_url")):
        return True
    return any(_contains_account_bound_file(item) for item in value.values())


def _mark_retryable_account_failure(token_info: Dict[str, Any], status: int) -> None:
    if status == 401:
        mark_invalid_token(token_info)
    elif status == 429:
        mark_rate_limited_token(token_info)


async def _execute_completion_with_failover(
    *,
    requested_chat_id: Optional[str],
    parent_id: Optional[str],
    message_content: Any,
    reset_message_content: Optional[str],
    mapped_model: str,
    system_message: Any,
    files: List[Any],
    on_chunk=None,
    client_scope: Optional[str] = None,
):
    """Resolve chat ownership and retry 401/429 only on a fresh account/chat pair."""
    if files or _contains_account_bound_file(message_content):
        return {
            "success": False,
            "status": 409,
            "error": (
                "Python runtime cannot verify the owning Qwen account for files; "
                "upload and send the file through the Node runtime"
            ),
            "requires_file_reupload": True,
        }

    # Alias and upstream ids resolve to one stable lock key. The key is carried
    # into a replacement binding so failover cannot split the lock domain.
    lock_key = _chat_affinity.canonical_key(requested_chat_id) or f"request:{uuid.uuid4()}"
    async with _chat_request_locks.hold(lock_key):
        binding = _chat_affinity.get(requested_chat_id)
        token_info = get_available_token_by_id(binding.account_id) if binding else None
        upstream_chat_id = binding.upstream_chat_id if token_info and binding else None
        needs_fresh_chat = upstream_chat_id is None

        excluded_account_ids = set()
        excluded_token_values = set()
        last_failure = None

        if token_info is None:
            token_info = get_available_token()

        while token_info is not None:
            account_id = _token_account_id(token_info)
            bearer = token_info.get("token")
            if account_id is None or not bearer:
                return {
                    "success": False,
                    "status": 401,
                    "error": "Некорректная конфигурация аккаунта Qwen",
                }

            effective_parent_id = None if needs_fresh_chat else parent_id
            async with _new_account_http_client(token_info) as account_client:
                if needs_fresh_chat:
                    create_result = await _create_qwen_chat_result(
                        token_info,
                        mapped_model,
                        client=account_client,
                    )
                    if not create_result.get("success"):
                        result = create_result
                    else:
                        upstream_chat_id = create_result["chat_id"]
                        primary_alias = requested_chat_id or _scope_external_chat_id(
                            upstream_chat_id,
                            client_scope,
                        ) or upstream_chat_id
                        _chat_affinity.bind(
                            primary_alias,
                            upstream_chat_id,
                            account_id,
                            lock_key=lock_key,
                        )
                        scoped_upstream_alias = _scope_external_chat_id(
                            upstream_chat_id,
                            client_scope,
                        )
                        if scoped_upstream_alias and scoped_upstream_alias != primary_alias:
                            _chat_affinity.bind(
                                scoped_upstream_alias,
                                upstream_chat_id,
                                account_id,
                                lock_key=lock_key,
                            )
                        effective_message = reset_message_content or message_content
                        payload = build_qwen_payload(
                            effective_message,
                            mapped_model,
                            upstream_chat_id,
                            parent_id=effective_parent_id,
                            system_message=system_message,
                            files=files,
                        )
                        result = await execute_qwen_completion(
                            token_info,
                            upstream_chat_id,
                            payload,
                            on_chunk=on_chunk,
                            client=account_client,
                        )
                else:
                    payload = build_qwen_payload(
                        message_content,
                        mapped_model,
                        upstream_chat_id,
                        parent_id=effective_parent_id,
                        system_message=system_message,
                        files=files,
                    )
                    result = await execute_qwen_completion(
                        token_info,
                        upstream_chat_id,
                        payload,
                        on_chunk=on_chunk,
                        client=account_client,
                    )

            result["chat_id"] = upstream_chat_id
            result["parent_id"] = effective_parent_id
            if result.get("success"):
                return result

            status = result.get("status")
            if status not in (401, 429):
                return result

            last_failure = result
            _mark_retryable_account_failure(token_info, status)

            # Retrying after any emitted SSE data would concatenate responses.
            if result.get("has_streamed_chunks"):
                result["error"] = "Upstream account failed after partial streaming output"
                return result

            excluded_account_ids.add(account_id)
            excluded_token_values.add(bearer)
            token_info = get_available_token(
                excluded_account_ids=excluded_account_ids,
                excluded_token_values=excluded_token_values,
            )
            upstream_chat_id = None
            needs_fresh_chat = True
            parent_id = None

        if last_failure is not None:
            return last_failure
        return {
            "success": False,
            "status": 401,
            "error": "Нет доступных аккаунтов.",
        }

# =================================================================
# FASTAPI APP
# =================================================================
app = FastAPI(title="FreeQwenApi Python")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip().rstrip("/") for origin in os.environ.get("CORS_ORIGINS", "").split(",") if origin.strip()],
    allow_origin_regex=r"^https?://(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

async def _stream_openai_response(completion_args: Dict[str, Any], model: str):
    queue: asyncio.Queue = asyncio.Queue()
    has_streamed_chunks = False

    def on_chunk(chunk_text: str):
        if chunk_text:
            queue.put_nowait(chunk_text)

    task = asyncio.create_task(
        _execute_completion_with_failover(**completion_args, on_chunk=on_chunk)
    )

    try:
        while True:
            if task.done() and queue.empty():
                break
            try:
                chunk = await asyncio.wait_for(queue.get(), timeout=0.2)
            except asyncio.TimeoutError:
                continue

            has_streamed_chunks = True
            yield "data: " + json.dumps({
                "id": "chatcmpl-stream",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "delta": {"content": chunk}, "finish_reason": None}]
            }, ensure_ascii=False) + "\n\n"

        result = await task
        if not result.get("success"):
            prefix = "\n\n" if has_streamed_chunks else ""
            err_text = f"{prefix}Ошибка: {result.get('error', 'Ошибка Qwen API')}"
            yield "data: " + json.dumps({
                "id": "chatcmpl-stream",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "delta": {"content": err_text}, "finish_reason": None}]
            }, ensure_ascii=False) + "\n\n"
        elif not has_streamed_chunks and result.get("content"):
            # Qwen иногда отвечает обычным JSON вместо SSE.
            yield "data: " + json.dumps({
                "id": "chatcmpl-stream",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": model,
                "choices": [{"index": 0, "delta": {"content": result["content"]}, "finish_reason": None}]
            }, ensure_ascii=False) + "\n\n"

        yield "data: " + json.dumps({
            "id": "chatcmpl-stream",
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": model,
            "chatId": result.get("chat_id"),
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]
        }, ensure_ascii=False) + "\n\n"
        yield "data: [DONE]\n\n"
    finally:
        if not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

async def handle_chat_completions(body: Dict[str, Any], client_scope: Optional[str] = None):
    messages = _extract_messages(body)
    if not messages:
        return JSONResponse(status_code=400, content={"error": "Сообщения не указаны"})

    model = body.get("model", DEFAULT_MODEL)
    stream = bool(body.get("stream", False))
    mapped_model = get_mapped_model(model)

    system_msg_obj = next((m for m in messages if isinstance(m, dict) and m.get("role") == "system"), None)
    system_msg = system_msg_obj.get("content") if isinstance(system_msg_obj, dict) else body.get("systemMessage")

    user_msg_obj = next((m for m in reversed(messages) if isinstance(m, dict) and m.get("role") == "user"), None)
    if not user_msg_obj:
        return JSONResponse(status_code=400, content={"error": "В запросе нет сообщений от пользователя"})

    message_content = _normalize_message_content(user_msg_obj.get("content", ""))
    reset_message_content = _build_stateless_transcript(messages)
    user_files = user_msg_obj.get("files")
    body_files = body.get("files")
    if user_files is not None and not isinstance(user_files, list):
        return JSONResponse(status_code=400, content={
            "error": {"message": "Поле files должно быть массивом", "type": "invalid_request_error"}
        })
    if user_files is None and body_files is not None and not isinstance(body_files, list):
        return JSONResponse(status_code=400, content={
            "error": {"message": "Поле files должно быть массивом", "type": "invalid_request_error"}
        })
    files = user_files if user_files is not None else (body_files or [])

    if files or _contains_account_bound_file(message_content):
        return JSONResponse(status_code=409, content={
            "error": {
                "message": (
                    "Python runtime cannot verify the owning Qwen account for files; "
                    "upload and send the file through the Node runtime"
                ),
                "type": "invalid_request_error",
                "reupload_required": True,
            }
        })

    if not _available_tokens():
        return JSONResponse(status_code=401, content={"error": "Нет доступных аккаунтов."})

    requested_chat_id, parent_id = _extract_chat_ids(body)
    requested_chat_id = _scope_external_chat_id(requested_chat_id, client_scope)
    completion_args = {
        "requested_chat_id": requested_chat_id,
        "parent_id": parent_id,
        "message_content": message_content,
        "reset_message_content": reset_message_content,
        "mapped_model": mapped_model,
        "system_message": system_msg,
        "files": files,
        "client_scope": client_scope,
    }

    if stream:
        headers = {
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
        return StreamingResponse(
            _stream_openai_response(completion_args, mapped_model),
            media_type="text/event-stream",
            headers=headers,
        )

    result = await _execute_completion_with_failover(**completion_args)
    if not result.get("success"):
        status = result.get("status") or 500
        if not isinstance(status, int) or status < 400:
            status = 500
        error_message = (
            result.get("error")
            if result.get("requires_file_reupload")
            else result.get("details") or result.get("error")
        ) or "Ошибка Qwen API"
        error_body = {"message": error_message, "type": "upstream_error"}
        if result.get("requires_file_reupload"):
            error_body["reupload_required"] = True
        return JSONResponse(
            status_code=status,
            content={"error": error_body}
        )

    response_parent_id = result.get("response_id") or result.get("parent_id")
    return _build_openai_completion(
        result.get("content", ""),
        model,
        result.get("chat_id"),
        response_parent_id,
        usage=result.get("usage"),
    )

@app.get("/api/chat/completions")
async def chat_completions_get():
    return JSONResponse(status_code=405, content={"error": "Метод не поддерживается", "message": "Используйте POST /api/chat/completions"})

@app.get("/api/v1/chat/completions")
async def chat_completions_v1_get():
    return JSONResponse(status_code=405, content={"error": "Метод не поддерживается", "message": "Используйте POST /api/v1/chat/completions"})

@app.post("/api/chat/completions")
async def chat_completions(request: Request):
    client_scope, auth_error = _authorize_proxy_request(request)
    if auth_error is not None:
        return auth_error
    body = await request.json()
    return await handle_chat_completions(body, client_scope)

@app.post("/api/v1/chat/completions")
async def chat_completions_v1(request: Request):
    client_scope, auth_error = _authorize_proxy_request(request)
    if auth_error is not None:
        return auth_error
    body = await request.json()
    return await handle_chat_completions(body, client_scope)

@app.post("/api/chat")
async def chat_endpoint(request: Request):
    client_scope, auth_error = _authorize_proxy_request(request)
    if auth_error is not None:
        return auth_error
    body = await request.json()
    return await handle_chat_completions(body, client_scope)

@app.get("/api/models")
async def list_models():
    models = load_available_models()
    return {
        "object": "list",
        "data": [
            {
                "id": m,
                "object": "model",
                "created": 0,
                "owned_by": "qwen",
                "permission": []
            }
            for m in models
        ]
    }

# =================================================================
# CLI MENU & LAUNCHER
# =================================================================
def print_banner():
    print(r"""
███████ ██████  ███████ ███████  ██████  ██     ██ ███████ ███    ██  █████  ██████  ██ 
██      ██   ██ ██      ██      ██    ██ ██     ██ ██      ████   ██ ██   ██ ██   ██ ██ 
█████   ██████  █████   █████   ██    ██ ██  █  ██ █████   ██ ██  ██ ███████ ██████  ██ 
██      ██   ██ ██      ██      ██ ▄▄ ██ ██ ███ ██ ██      ██  ██ ██ ██   ██ ██      ██ 
██      ██   ██ ███████ ███████  ██████   ███ ███  ███████ ██   ████ ██   ██ ██      ██ 
                                    ▀▀                                                    
   API-прокси для Qwen (Python Native)
""")

async def interactive_menu():
    while True:
        os.system('clear' if os.name == 'posix' else 'cls')
        print_banner()
        
        tokens = load_tokens()
        print("\nСписок аккаунтов:")
        if not tokens:
            print("  (пусто)")
        else:
            for i, t in enumerate(tokens):
                is_limited = False
                if t.get('resetAt'):
                    is_limited = datetime.fromisoformat(t['resetAt'].replace('Z', '+00:00')).timestamp() > time.time()
                status = "⏳ Лимит" if is_limited else "✅ OK"
                print(f"  {i+1} | {t['id']} | {status}")
        
        print("\n=== Меню ===")
        print("1 - Добавить новый аккаунт")
        print("2 - Перелогинить (не реализовано в этой версии)")
        print("3 - Запустить прокси (по умолчанию)")
        print("4 - Удалить аккаунт")
        print("0 - Выход")
        
        try:
            choice = input("\nВаш выбор (Enter = 3): ").strip()
        except EOFError: break
        
        if choice == "" or choice == "3":
            if not tokens:
                print("Ошибка: Сначала добавьте хотя бы один аккаунт (пункт 1).")
                time.sleep(2)
                continue
            print(f"\nЗапуск сервера на {HOST}:{PORT}...")
            config = uvicorn.Config(app, host=HOST, port=PORT, log_level="info")
            server = uvicorn.Server(config)
            await server.serve()
            break
        elif choice == "1":
            print("\n--- Добавление аккаунта ---")
            print("1 - Ручной вход в браузере (надежнее)")
            print("2 - Автоматический вход (Email + Пароль)")
            sub_choice = input("Выберите способ: ").strip()
            
            if sub_choice == "2":
                email = input("Email: ").strip()
                password = input("Пароль: ").strip()
                # Возвращаем видимый браузер по просьбе пользователя
                await login_interactive(email, password, headless=False)
            else:
                await login_interactive(headless=False)
        elif choice == "4":
            if not tokens: continue
            try:
                idx = int(input("Введите номер аккаунта для удаления: ")) - 1
                if 0 <= idx < len(tokens):
                    tokens.pop(idx)
                    save_tokens(tokens)
                    print("Аккаунт удален.")
                    time.sleep(1)
            except ValueError: pass
        elif choice == "0":
            break

if __name__ == "__main__":
    try:
        asyncio.run(interactive_menu())
    except KeyboardInterrupt:
        pass
