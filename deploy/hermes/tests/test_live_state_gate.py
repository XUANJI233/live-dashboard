import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "live_state_gate.py"
SPEC = importlib.util.spec_from_file_location("live_state_gate", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class LiveStateGateTest(unittest.TestCase):
    def test_watch_or_phone_sleep_is_authoritative(self):
        payload = {"rest_state": "asleep"}
        self.assertEqual(MODULE.rest_state_from_current(payload), "asleep")

    def test_idle_phone_is_screen_off_but_not_confirmed_sleep(self):
        payload = {"rest_state": "screen_off"}
        self.assertEqual(MODULE.rest_state_from_current(payload), "screen_off")

    def test_active_phone_keeps_normal_cadence(self):
        payload = {"rest_state": "active"}
        self.assertEqual(MODULE.rest_state_from_current(payload), "active")

    def test_missing_or_invalid_state_is_unknown(self):
        self.assertEqual(MODULE.rest_state_from_current({}), "unknown")
        self.assertEqual(MODULE.rest_state_from_current({"rest_state": "bad"}), "unknown")


if __name__ == "__main__":
    unittest.main()
