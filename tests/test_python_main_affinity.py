import ast
import asyncio
import copy
import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from python_affinity import ChatAffinityRegistry, StripedAsyncLockPool


REPO_ROOT = Path(__file__).resolve().parents[1]


class _FakeFastAPI:
    def __init__(self, *args, **kwargs):
        pass

    def add_middleware(self, *args, **kwargs):
        pass

    def get(self, *args, **kwargs):
        return lambda function: function

    def post(self, *args, **kwargs):
        return lambda function: function


class _FakeResponse:
    def __init__(self, *args, **kwargs):
        self.args = args
        self.kwargs = kwargs


class _FakeCookies:
    def set(self, *args, **kwargs):
        pass


class _FakeAsyncClient:
    pass


def _stubbed_runtime_modules():
    httpx = types.ModuleType("httpx")
    httpx.AsyncClient = _FakeAsyncClient
    httpx.Cookies = _FakeCookies

    uvicorn = types.ModuleType("uvicorn")
    uvicorn.Config = object
    uvicorn.Server = object

    fastapi = types.ModuleType("fastapi")
    fastapi.FastAPI = _FakeFastAPI
    fastapi.Request = object
    fastapi.Response = object
    fastapi.HTTPException = Exception

    responses = types.ModuleType("fastapi.responses")
    responses.StreamingResponse = _FakeResponse
    responses.JSONResponse = _FakeResponse

    middleware = types.ModuleType("fastapi.middleware")
    cors = types.ModuleType("fastapi.middleware.cors")
    cors.CORSMiddleware = object

    playwright = types.ModuleType("playwright")
    playwright_async = types.ModuleType("playwright.async_api")
    playwright_async.async_playwright = lambda: None

    pydantic = types.ModuleType("pydantic")
    pydantic.BaseModel = object

    dotenv = types.ModuleType("dotenv")
    dotenv.load_dotenv = lambda *args, **kwargs: False

    return {
        "httpx": httpx,
        "uvicorn": uvicorn,
        "fastapi": fastapi,
        "fastapi.responses": responses,
        "fastapi.middleware": middleware,
        "fastapi.middleware.cors": cors,
        "playwright": playwright,
        "playwright.async_api": playwright_async,
        "pydantic": pydantic,
        "dotenv": dotenv,
    }


def _load_main_without_external_dependencies():
    spec = importlib.util.spec_from_file_location("freeqwen_test_main", REPO_ROOT / "main.py")
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, _stubbed_runtime_modules()):
        spec.loader.exec_module(module)
    return module


class _DummyAccountClient:
    def __init__(self, account_id):
        self.account_id = account_id

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, traceback):
        return False


class PythonMainAffinityTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.main = _load_main_without_external_dependencies()

    def setUp(self):
        self.main._chat_affinity = ChatAffinityRegistry()
        self.main._chat_request_locks = StripedAsyncLockPool(stripes=17)
        self.token_a = {"id": "account-a", "token": "test-token-a"}
        self.token_b = {"id": "account-b", "token": "test-token-b"}
        self.clients = []
        self.marked_failures = []

        def new_client(token_info):
            client = _DummyAccountClient(token_info["id"])
            self.clients.append(client)
            return client

        self.main._new_account_http_client = new_client
        self.main._mark_retryable_account_failure = (
            lambda token_info, status: self.marked_failures.append((token_info["id"], status))
        )

    async def test_bound_chat_reuses_its_owner_without_creating_a_chat(self):
        self.main._chat_affinity.bind("client-alias", "existing-chat", "account-a")
        self.main.get_available_token_by_id = (
            lambda account_id: copy.deepcopy(self.token_a) if account_id == "account-a" else None
        )
        self.main.get_available_token = lambda **kwargs: copy.deepcopy(self.token_b)
        create_calls = []
        execute_calls = []

        async def create_chat(*args, **kwargs):
            create_calls.append(args[0]["id"])
            return {"success": True, "chat_id": "unexpected-chat"}

        async def execute(token_info, chat_id, payload, **kwargs):
            execute_calls.append((token_info["id"], chat_id, payload))
            return {"success": True, "content": "ok"}

        self.main._create_qwen_chat_result = create_chat
        self.main.execute_qwen_completion = execute

        result = await self.main._execute_completion_with_failover(
            requested_chat_id="client-alias",
            parent_id="parent-1",
            message_content="next turn",
            reset_message_content="full transcript",
            mapped_model="qwen-test",
            system_message=None,
            files=[],
        )

        self.assertTrue(result["success"])
        self.assertEqual(create_calls, [])
        self.assertEqual(execute_calls[0][0:2], ("account-a", "existing-chat"))
        self.assertEqual(execute_calls[0][2]["parent_id"], "parent-1")
        self.assertEqual(execute_calls[0][2]["messages"][0]["content"], "next turn")
        self.assertEqual([client.account_id for client in self.clients], ["account-a"])

    async def test_first_turn_upstream_is_reusable_only_in_the_same_client_scope(self):
        self.main.get_available_token = lambda **kwargs: copy.deepcopy(self.token_a)
        self.main.get_available_token_by_id = (
            lambda account_id: copy.deepcopy(self.token_a) if account_id == "account-a" else None
        )
        create_calls = []
        execute_calls = []

        async def create_chat(token_info, model, client=None):
            chat_id = f"upstream-{len(create_calls) + 1}"
            create_calls.append(chat_id)
            return {"success": True, "chat_id": chat_id}

        async def execute(token_info, chat_id, payload, **kwargs):
            execute_calls.append((chat_id, payload["messages"][0]["content"]))
            return {"success": True, "content": "ok"}

        self.main._create_qwen_chat_result = create_chat
        self.main.execute_qwen_completion = execute

        first = await self.main._execute_completion_with_failover(
            requested_chat_id=None,
            parent_id=None,
            message_content="first",
            reset_message_content=None,
            mapped_model="qwen-test",
            system_message=None,
            files=[],
            client_scope="client-a",
        )
        self.assertEqual(first["chat_id"], "upstream-1")

        same_client_alias = self.main._scope_external_chat_id(first["chat_id"], "client-a")
        second = await self.main._execute_completion_with_failover(
            requested_chat_id=same_client_alias,
            parent_id="parent-a",
            message_content="second",
            reset_message_content=None,
            mapped_model="qwen-test",
            system_message=None,
            files=[],
            client_scope="client-a",
        )
        self.assertEqual(second["chat_id"], "upstream-1")

        other_client_alias = self.main._scope_external_chat_id(first["chat_id"], "client-b")
        third = await self.main._execute_completion_with_failover(
            requested_chat_id=other_client_alias,
            parent_id="leaked-parent",
            message_content="third",
            reset_message_content=None,
            mapped_model="qwen-test",
            system_message=None,
            files=[],
            client_scope="client-b",
        )
        self.assertEqual(third["chat_id"], "upstream-2")
        self.assertEqual(create_calls, ["upstream-1", "upstream-2"])
        self.assertEqual(execute_calls, [
            ("upstream-1", "first"),
            ("upstream-1", "second"),
            ("upstream-2", "third"),
        ])

    async def test_429_failover_uses_new_account_new_chat_and_full_history(self):
        self.main._chat_affinity.bind("client-alias", "old-chat", "account-a")
        self.main.get_available_token_by_id = lambda account_id: copy.deepcopy(
            self.token_a if account_id == "account-a" else self.token_b
        ) if account_id in {"account-a", "account-b"} else None

        def select_token(excluded_account_ids=None, excluded_token_values=None):
            if "account-b" not in set(excluded_account_ids or ()):
                return copy.deepcopy(self.token_b)
            return None

        self.main.get_available_token = select_token
        create_calls = []
        execute_calls = []

        async def create_chat(token_info, model, client=None):
            create_calls.append((token_info["id"], client.account_id))
            return {"success": True, "chat_id": "new-chat-b"}

        async def execute(token_info, chat_id, payload, **kwargs):
            execute_calls.append((token_info["id"], chat_id, payload))
            if token_info["id"] == "account-a":
                return {"success": False, "status": 429, "error": "RateLimited"}
            return {"success": True, "content": "recovered", "response_id": "response-b"}

        self.main._create_qwen_chat_result = create_chat
        self.main.execute_qwen_completion = execute

        result = await self.main._execute_completion_with_failover(
            requested_chat_id="client-alias",
            parent_id="old-parent",
            message_content="latest turn",
            reset_message_content="full transcript",
            mapped_model="qwen-test",
            system_message="system",
            files=[],
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["chat_id"], "new-chat-b")
        self.assertIsNone(result["parent_id"])
        self.assertEqual(create_calls, [("account-b", "account-b")])
        self.assertEqual(self.marked_failures, [("account-a", 429)])
        self.assertEqual([call[0:2] for call in execute_calls], [
            ("account-a", "old-chat"),
            ("account-b", "new-chat-b"),
        ])
        self.assertEqual(execute_calls[1][2]["parent_id"], None)
        self.assertEqual(execute_calls[1][2]["messages"][0]["content"], "full transcript")
        rebound = self.main._chat_affinity.get("client-alias")
        self.assertEqual((rebound.account_id, rebound.upstream_chat_id), ("account-b", "new-chat-b"))
        self.assertEqual(self.main._chat_affinity.canonical_key("old-chat"), "client-alias")
        self.assertEqual(self.main._chat_affinity.canonical_key("new-chat-b"), "client-alias")
        stale_binding = self.main._chat_affinity.get("old-chat")
        self.assertEqual((stale_binding.account_id, stale_binding.upstream_chat_id), ("account-b", "new-chat-b"))
        self.assertEqual([client.account_id for client in self.clients], ["account-a", "account-b"])
        self.assertIsNot(self.clients[0], self.clients[1])

        second_result = await self.main._execute_completion_with_failover(
            requested_chat_id="old-chat",
            parent_id="response-b",
            message_content="turn after failover",
            reset_message_content="unused transcript",
            mapped_model="qwen-test",
            system_message="system",
            files=[],
        )
        self.assertTrue(second_result["success"])
        self.assertEqual(second_result["chat_id"], "new-chat-b")
        self.assertEqual(create_calls, [("account-b", "account-b")])
        self.assertEqual(execute_calls[-1][0:2], ("account-b", "new-chat-b"))
        self.assertEqual(execute_calls[-1][2]["messages"][0]["content"], "turn after failover")

    async def test_partial_stream_is_never_retried_on_another_account(self):
        self.main._chat_affinity.bind("client-alias", "old-chat", "account-a")
        self.main.get_available_token_by_id = lambda account_id: copy.deepcopy(self.token_a)
        selected_fallbacks = []
        self.main.get_available_token = lambda **kwargs: selected_fallbacks.append(kwargs)

        async def execute(*args, **kwargs):
            return {
                "success": False,
                "status": 429,
                "error": "RateLimited",
                "has_streamed_chunks": True,
            }

        self.main.execute_qwen_completion = execute

        result = await self.main._execute_completion_with_failover(
            requested_chat_id="client-alias",
            parent_id="old-parent",
            message_content="latest turn",
            reset_message_content="full transcript",
            mapped_model="qwen-test",
            system_message=None,
            files=[],
        )

        self.assertFalse(result["success"])
        self.assertIn("partial", result["error"].lower())
        self.assertEqual(selected_fallbacks, [])
        self.assertEqual(len(self.clients), 1)

    async def test_401_failover_invalidates_owner_and_uses_fresh_chat(self):
        self.main._chat_affinity.bind("client-alias", "old-chat", "account-a")
        self.main.get_available_token_by_id = lambda account_id: copy.deepcopy(self.token_a)
        self.main.get_available_token = lambda **kwargs: copy.deepcopy(self.token_b)
        create_accounts = []

        async def create_chat(token_info, model, client=None):
            create_accounts.append(token_info["id"])
            return {"success": True, "chat_id": "new-chat-b"}

        async def execute(token_info, chat_id, payload, **kwargs):
            if token_info["id"] == "account-a":
                return {"success": False, "status": 401, "error": "Unauthorized"}
            return {"success": True, "content": "recovered"}

        self.main._create_qwen_chat_result = create_chat
        self.main.execute_qwen_completion = execute

        result = await self.main._execute_completion_with_failover(
            requested_chat_id="client-alias",
            parent_id="old-parent",
            message_content="latest turn",
            reset_message_content="full transcript",
            mapped_model="qwen-test",
            system_message=None,
            files=[],
        )

        self.assertTrue(result["success"])
        self.assertEqual(result["chat_id"], "new-chat-b")
        self.assertEqual(create_accounts, ["account-b"])
        self.assertEqual(self.marked_failures, [("account-a", 401)])

    async def test_files_fail_closed_before_selecting_an_account(self):
        self.main.get_available_token = lambda **kwargs: self.fail("must not select an account")
        self.main.get_available_token_by_id = lambda account_id: self.fail("must not resolve an owner")

        result = await self.main._execute_completion_with_failover(
            requested_chat_id="unknown-chat",
            parent_id=None,
            message_content="read file",
            reset_message_content=None,
            mapped_model="qwen-test",
            system_message=None,
            files=[{"file_id": "account-bound-file"}],
        )

        self.assertFalse(result["success"])
        self.assertEqual(result["status"], 409)
        self.assertTrue(result["requires_file_reupload"])
        self.assertEqual(self.clients, [])

        embedded_result = await self.main._execute_completion_with_failover(
            requested_chat_id="unknown-chat",
            parent_id=None,
            message_content=[{"type": "file", "file": "account-bound-file"}],
            reset_message_content=None,
            mapped_model="qwen-test",
            system_message=None,
            files=[],
        )
        self.assertEqual(embedded_result["status"], 409)
        self.assertTrue(embedded_result["requires_file_reupload"])

    def test_embedded_file_detector_covers_nested_openai_content(self):
        self.assertTrue(self.main._contains_account_bound_file([
            {
                "type": "input_file",
                "input_file": {"file_id": "account-bound-file"},
            }
        ]))
        self.assertTrue(self.main._contains_account_bound_file({
            "content": [{"type": "file", "file": "account-bound-file"}],
        }))
        self.assertFalse(self.main._contains_account_bound_file([
            {"type": "text", "text": "ordinary message"},
        ]))

    async def test_streaming_file_request_returns_http_conflict_before_streaming(self):
        self.main._available_tokens = lambda: self.fail("must fail before token selection")
        response = await self.main.handle_chat_completions({
            "stream": True,
            "messages": [{
                "role": "user",
                "content": "read file",
                "files": [{"file_id": "account-bound-file"}],
            }],
        }, client_scope="client-a")

        self.assertEqual(response.kwargs["status_code"], 409)
        self.assertTrue(response.kwargs["content"]["error"]["reupload_required"])

    def test_proxy_client_scope_uses_only_a_credential_fingerprint(self):
        fingerprint_a = self.main.hashlib.sha256(b"proxy-key-a").hexdigest()
        fingerprint_b = self.main.hashlib.sha256(b"proxy-key-b").hexdigest()
        scope_a = self.main._build_proxy_client_scope("127.0.0.1", "OpenAI/JS", fingerprint_a)
        scope_b = self.main._build_proxy_client_scope("127.0.0.1", "OpenAI/JS", fingerprint_b)

        self.assertNotEqual(scope_a, scope_b)
        self.assertNotIn("proxy-key-a", scope_a)

    def test_python_proxy_auth_scopes_only_validated_bearers(self):
        request_a = types.SimpleNamespace(
            headers={"authorization": "Bearer proxy-key-a", "user-agent": "OpenAI/JS"},
            client=types.SimpleNamespace(host="127.0.0.1"),
        )
        request_b = types.SimpleNamespace(
            headers={"authorization": "Bearer proxy-key-b", "user-agent": "OpenAI/JS"},
            client=types.SimpleNamespace(host="127.0.0.1"),
        )
        invalid_request = types.SimpleNamespace(
            headers={"authorization": "Bearer untrusted-key", "user-agent": "OpenAI/JS"},
            client=types.SimpleNamespace(host="127.0.0.1"),
        )

        with patch.object(self.main, "_load_proxy_api_keys", return_value=["proxy-key-a", "proxy-key-b"]):
            scope_a, error_a = self.main._authorize_proxy_request(request_a)
            scope_b, error_b = self.main._authorize_proxy_request(request_b)
            invalid_scope, invalid_error = self.main._authorize_proxy_request(invalid_request)

        self.assertIsNone(error_a)
        self.assertIsNone(error_b)
        self.assertNotEqual(scope_a, scope_b)
        self.assertIsNone(invalid_scope)
        self.assertEqual(invalid_error.kwargs["status_code"], 401)

    def test_no_module_global_http_cookie_jar(self):
        tree = ast.parse((REPO_ROOT / "main.py").read_text(encoding="utf-8"))
        assigned_names = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                assigned_names.update(
                    target.id for target in node.targets if isinstance(target, ast.Name)
                )
            elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
                assigned_names.add(node.target.id)

        self.assertNotIn("http_client", assigned_names)


if __name__ == "__main__":
    unittest.main()
