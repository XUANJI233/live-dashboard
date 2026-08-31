import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "proactive_candidate.py"
SPEC = importlib.util.spec_from_file_location("proactive_candidate", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
TZ = timezone(timedelta(hours=8), name="UTC+08:00")


class ProactiveCandidateTest(unittest.TestCase):
    def test_creates_candidates_without_turning_every_tick_into_a_model_run(self):
        state = {}
        state, first = MODULE.evaluate_candidate(state, datetime(2026, 9, 1, 9, 0, tzinfo=TZ), 0.0)
        state, cooldown = MODULE.evaluate_candidate(state, datetime(2026, 9, 1, 9, 30, tzinfo=TZ), 0.0)
        state, rejected = MODULE.evaluate_candidate(state, datetime(2026, 9, 1, 12, 0, tzinfo=TZ), 1.0)
        state, second = MODULE.evaluate_candidate(state, datetime(2026, 9, 1, 12, 30, tzinfo=TZ), 0.0)

        self.assertNotEqual(first, '{"candidate_id":"none"}')
        self.assertEqual(cooldown, first)
        self.assertEqual(rejected, first)
        self.assertNotEqual(second, first)
        self.assertEqual(state["day_count"], 2)

    def test_quiet_hours_lower_probability_without_forbidding_contact(self):
        quiet = datetime(2026, 9, 1, 23, 30, tzinfo=TZ)
        _, rejected = MODULE.evaluate_candidate({}, quiet, 0.04)
        accepted_state, accepted = MODULE.evaluate_candidate({}, quiet, 0.02)

        self.assertEqual(rejected, '{"candidate_id":"none"}')
        self.assertNotEqual(accepted, '{"candidate_id":"none"}')
        self.assertEqual(accepted_state["day_count"], 1)


if __name__ == "__main__":
    unittest.main()
