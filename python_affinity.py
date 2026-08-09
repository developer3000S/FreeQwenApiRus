"""Small, dependency-free helpers for Python chat/account affinity."""

import asyncio
import hashlib
import weakref
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Optional


@dataclass(frozen=True)
class ChatBinding:
    account_id: str
    upstream_chat_id: str
    lock_key: str


class ChatAffinityRegistry:
    """Bounded LRU registry that never stores bearer tokens."""

    def __init__(self, max_entries: int = 10_000):
        if max_entries < 1:
            raise ValueError("max_entries must be positive")
        self._max_entries = max_entries
        self._entries = OrderedDict()

    def get(self, chat_alias: Optional[str]) -> Optional[ChatBinding]:
        key = self._normalize(chat_alias)
        if key is None:
            return None
        binding = self._entries.get(key)
        if binding is not None:
            self._entries.move_to_end(key)
        return binding

    def bind(
        self,
        chat_alias: str,
        upstream_chat_id: str,
        account_id: str,
        lock_key: Optional[str] = None,
    ) -> ChatBinding:
        alias = self._normalize(chat_alias)
        upstream = self._normalize(upstream_chat_id)
        owner = self._normalize(account_id)
        if alias is None or upstream is None or owner is None:
            raise ValueError("chat alias, upstream chat id, and account id are required")

        existing = self.get(alias) or self.get(upstream)
        explicit_lock_key = self._normalize(lock_key)
        canonical_lock_key = explicit_lock_key or (existing.lock_key if existing else alias)
        binding = ChatBinding(
            account_id=owner,
            upstream_chat_id=upstream,
            lock_key=canonical_lock_key,
        )
        # Repoint every alias/upstream tombstone in this lock domain. A queued
        # request using the pre-failover upstream id must continue on the same
        # replacement chat instead of creating a fork.
        for resource_id, candidate in list(self._entries.items()):
            if candidate.lock_key == canonical_lock_key:
                self._entries[resource_id] = binding
        self._put(upstream, binding)
        self._put(alias, binding)
        self._trim()
        return binding

    def forget(self, chat_alias: Optional[str]) -> None:
        key = self._normalize(chat_alias)
        if key is not None:
            self._entries.pop(key, None)

    def forget_upstream(self, upstream_chat_id: Optional[str]) -> None:
        upstream = self._normalize(upstream_chat_id)
        if upstream is None:
            return
        stale_keys = [
            key
            for key, binding in self._entries.items()
            if binding.upstream_chat_id == upstream
        ]
        for key in stale_keys:
            self._entries.pop(key, None)

    def canonical_key(self, chat_alias: Optional[str]) -> Optional[str]:
        key = self._normalize(chat_alias)
        if key is None:
            return None
        binding = self.get(key)
        return binding.lock_key if binding is not None else key

    def __len__(self) -> int:
        return len(self._entries)

    @staticmethod
    def _normalize(value) -> Optional[str]:
        if value is None:
            return None
        normalized = str(value).strip()
        return normalized or None

    def _put(self, key: str, binding: ChatBinding) -> None:
        self._entries[key] = binding
        self._entries.move_to_end(key)

    def _trim(self) -> None:
        while len(self._entries) > self._max_entries:
            oldest_binding = next(iter(self._entries.values()))
            stale_keys = [
                key
                for key, binding in self._entries.items()
                if binding.lock_key == oldest_binding.lock_key
            ]
            for key in stale_keys:
                self._entries.pop(key, None)


class StripedAsyncLockPool:
    """A fixed-size keyed lock pool, isolated per asyncio event loop."""

    def __init__(self, stripes: int = 257):
        if stripes < 1:
            raise ValueError("stripes must be positive")
        self._stripes = stripes
        self._locks_by_loop = weakref.WeakKeyDictionary()

    def _lock_for(self, key: str) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        locks = self._locks_by_loop.get(loop)
        if locks is None:
            locks = tuple(asyncio.Lock() for _ in range(self._stripes))
            self._locks_by_loop[loop] = locks
        digest = hashlib.blake2b(str(key).encode("utf-8"), digest_size=8).digest()
        index = int.from_bytes(digest, "big") % self._stripes
        return locks[index]

    @asynccontextmanager
    async def hold(self, key: str):
        lock = self._lock_for(key)
        await lock.acquire()
        try:
            yield
        finally:
            lock.release()
