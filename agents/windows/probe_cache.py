"""Small TTL cache for expensive Windows polling probes."""

from __future__ import annotations

from collections.abc import Callable
import time
from typing import TypeVar

T = TypeVar("T")


class TimedProbe:
    """Cache a probe result briefly to keep long-running monitor loops cheap."""

    def __init__(
        self,
        probe: Callable[[], T],
        ttl_seconds: float,
        fallback: T,
        clock: Callable[[], float] | None = None,
    ):
        self._probe = probe
        self._ttl_seconds = max(0.0, ttl_seconds)
        self._fallback = fallback
        self._clock = clock or time.monotonic
        self._value: T = fallback
        self._expires_at = 0.0

    def get(self, force: bool = False) -> T:
        now = self._clock()
        if force or now >= self._expires_at:
            try:
                self._value = self._probe()
            except Exception:
                self._value = self._fallback
            self._expires_at = now + self._ttl_seconds
        return self._value
