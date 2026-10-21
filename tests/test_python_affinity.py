import asyncio
import unittest

from python_affinity import ChatAffinityRegistry, StripedAsyncLockPool


class ChatAffinityRegistryTests(unittest.TestCase):
    def test_alias_and_upstream_chat_resolve_to_same_owner(self):
        registry = ChatAffinityRegistry()

        registry.bind("client-alias", "qwen-chat-1", "account-a")

        self.assertEqual(registry.get("client-alias").account_id, "account-a")
        self.assertEqual(registry.get("qwen-chat-1").account_id, "account-a")
        self.assertEqual(registry.canonical_key("client-alias"), "client-alias")
        self.assertEqual(registry.canonical_key("qwen-chat-1"), "client-alias")

    def test_forget_upstream_removes_every_alias(self):
        registry = ChatAffinityRegistry()
        registry.bind("first-alias", "qwen-chat-1", "account-a")
        registry.bind("second-alias", "qwen-chat-1", "account-a")

        registry.forget_upstream("qwen-chat-1")

        self.assertIsNone(registry.get("first-alias"))
        self.assertIsNone(registry.get("second-alias"))
        self.assertIsNone(registry.get("qwen-chat-1"))

    def test_registry_is_bounded(self):
        registry = ChatAffinityRegistry(max_entries=3)

        registry.bind("alias-1", "chat-1", "account-a")
        registry.bind("alias-2", "chat-2", "account-b")

        self.assertLessEqual(len(registry), 3)
        self.assertIsNone(registry.get("alias-1"))
        self.assertIsNone(registry.get("chat-1"))
        self.assertEqual(registry.get("alias-2").upstream_chat_id, "chat-2")
        self.assertEqual(registry.get("chat-2").lock_key, "alias-2")


class StripedAsyncLockPoolTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_key_requests_do_not_overlap(self):
        pool = StripedAsyncLockPool(stripes=17)
        entered = []
        first_entered = asyncio.Event()
        release_first = asyncio.Event()

        async def first():
            async with pool.hold("same-chat"):
                entered.append("first")
                first_entered.set()
                await release_first.wait()

        async def second():
            await first_entered.wait()
            async with pool.hold("same-chat"):
                entered.append("second")

        first_task = asyncio.create_task(first())
        second_task = asyncio.create_task(second())
        await first_entered.wait()
        await asyncio.sleep(0)
        self.assertEqual(entered, ["first"])

        release_first.set()
        await asyncio.gather(first_task, second_task)
        self.assertEqual(entered, ["first", "second"])

    async def test_alias_and_upstream_id_cannot_enter_concurrently(self):
        registry = ChatAffinityRegistry()
        registry.bind("client-alias", "upstream-chat", "account-a")
        pool = StripedAsyncLockPool(stripes=17)
        alias_entered = asyncio.Event()
        release_alias = asyncio.Event()
        upstream_entered = False

        async def alias_request():
            async with pool.hold(registry.canonical_key("client-alias")):
                alias_entered.set()
                await release_alias.wait()

        async def upstream_request():
            nonlocal upstream_entered
            await alias_entered.wait()
            async with pool.hold(registry.canonical_key("upstream-chat")):
                upstream_entered = True

        alias_task = asyncio.create_task(alias_request())
        upstream_task = asyncio.create_task(upstream_request())
        await alias_entered.wait()
        await asyncio.sleep(0)
        self.assertFalse(upstream_entered)

        release_alias.set()
        await asyncio.gather(alias_task, upstream_task)
        self.assertTrue(upstream_entered)


if __name__ == "__main__":
    unittest.main()
