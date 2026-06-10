import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from probe_cache import TimedProbe


class TimedProbeTests(unittest.TestCase):
    def test_caches_until_ttl_expires(self):
        now = 0.0
        values = iter([1, 2])
        calls = 0

        def clock():
            return now

        def probe():
            nonlocal calls
            calls += 1
            return next(values)

        cached = TimedProbe(probe, ttl_seconds=5, fallback=0, clock=clock)

        self.assertEqual(cached.get(), 1)
        self.assertEqual(cached.get(), 1)
        self.assertEqual(calls, 1)

        now = 6.0

        self.assertEqual(cached.get(), 2)
        self.assertEqual(calls, 2)

    def test_uses_fallback_when_probe_fails(self):
        cached = TimedProbe(lambda: (_ for _ in ()).throw(RuntimeError("boom")), ttl_seconds=5, fallback=False)

        self.assertFalse(cached.get(force=True))


if __name__ == "__main__":
    unittest.main()
