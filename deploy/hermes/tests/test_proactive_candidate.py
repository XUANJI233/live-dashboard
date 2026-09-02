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
    def test_marks_only_selected_slots_as_real_candidates(self):
        state = {}
        state, first = MODULE.evaluate_candidate(state, datetime(2026, 9, 1, 9, 0, tzinfo=TZ), 0.0)
        state, cooldown = MODULE.evaluate_candidate(state, datetime(2026, 9, 1, 9, 30, tzinfo=TZ), 0.0)
        state, rejected = MODULE.evaluate_candidate(state, datetime(2026, 9, 1, 10, 30, tzinfo=TZ), 1.0)
        state, second = MODULE.evaluate_candidate(state, datetime(2026, 9, 1, 11, 0, tzinfo=TZ), 0.0)

        self.assertNotEqual(first, MODULE.NO_CANDIDATE)
        self.assertEqual(cooldown, MODULE.NO_CANDIDATE)
        self.assertEqual(rejected, MODULE.NO_CANDIDATE)
        self.assertNotEqual(second, first)
        self.assertEqual(state["day_count"], 2)

    def test_quiet_hours_lower_probability_without_forbidding_contact(self):
        quiet = datetime(2026, 9, 1, 23, 30, tzinfo=TZ)
        _, rejected = MODULE.evaluate_candidate({}, quiet, 0.06)
        accepted_state, accepted = MODULE.evaluate_candidate({}, quiet, 0.04)

        self.assertEqual(rejected, MODULE.NO_CANDIDATE)
        self.assertNotEqual(accepted, MODULE.NO_CANDIDATE)
        self.assertEqual(accepted_state["day_count"], 1)

    def test_screen_off_reduces_probability_and_sleep_suppresses_candidates(self):
        daytime = datetime(2026, 9, 1, 9, 0, tzinfo=TZ)
        _, active = MODULE.evaluate_candidate({}, daytime, 0.2, rest_state="active")
        _, screen_off = MODULE.evaluate_candidate({}, daytime, 0.2, rest_state="screen_off")
        _, sleeping = MODULE.evaluate_candidate({}, daytime, 0.0, rest_state="asleep")

        self.assertNotEqual(active, MODULE.NO_CANDIDATE)
        self.assertEqual(screen_off, MODULE.NO_CANDIDATE)
        self.assertEqual(sleeping, MODULE.NO_CANDIDATE)

    def test_daytime_probability_boundary_is_pinned(self):
        daytime = datetime(2026, 9, 1, 9, 0, tzinfo=TZ)
        _, accepted = MODULE.evaluate_candidate({}, daytime, 0.499999)
        _, rejected = MODULE.evaluate_candidate({}, daytime, 0.5)

        self.assertNotEqual(accepted, MODULE.NO_CANDIDATE)
        self.assertEqual(rejected, MODULE.NO_CANDIDATE)

    def test_cooldown_boundary_is_ninety_minutes(self):
        state, first = MODULE.evaluate_candidate(
            {}, datetime(2026, 9, 1, 9, 0, tzinfo=TZ), 0.0
        )
        state, before = MODULE.evaluate_candidate(
            state, datetime(2026, 9, 1, 10, 0, tzinfo=TZ), 0.0
        )
        state, boundary = MODULE.evaluate_candidate(
            state, datetime(2026, 9, 1, 10, 30, tzinfo=TZ), 0.0
        )

        self.assertEqual(before, MODULE.NO_CANDIDATE)
        self.assertNotEqual(boundary, MODULE.NO_CANDIDATE)

    def test_allows_more_than_three_well_spaced_daytime_candidates(self):
        state = {}
        outputs = []
        for hour in (8, 10, 12, 14, 16, 18):
            state, output = MODULE.evaluate_candidate(
                state, datetime(2026, 9, 1, hour, 0, tzinfo=TZ), 0.0
            )
            outputs.append(output)

        self.assertEqual(len(set(outputs)), 6)
        self.assertEqual(state["day_count"], 6)

        state, seventh = MODULE.evaluate_candidate(
            state, datetime(2026, 9, 1, 20, 0, tzinfo=TZ), 0.0
        )
        self.assertEqual(seventh, MODULE.NO_CANDIDATE)
        self.assertEqual(state["day_count"], 6)

    def test_one_slot_never_redraws_after_rejection(self):
        state, first = MODULE.evaluate_candidate(
            {}, datetime(2026, 9, 1, 9, 0, tzinfo=TZ), 1.0
        )
        state, second = MODULE.evaluate_candidate(
            state, datetime(2026, 9, 1, 9, 5, tzinfo=TZ), 0.0
        )

        self.assertEqual(first, MODULE.NO_CANDIDATE)
        self.assertEqual(second, first)
        self.assertEqual(state["day_count"], 0)

    def test_selected_slot_is_stable_when_evaluated_twice(self):
        state, first = MODULE.evaluate_candidate(
            {}, datetime(2026, 9, 1, 9, 0, tzinfo=TZ), 0.0
        )
        state, second = MODULE.evaluate_candidate(
            state, datetime(2026, 9, 1, 9, 5, tzinfo=TZ), 1.0
        )

        self.assertEqual(second, first)
        self.assertIn('"selected_this_run":true', second)


if __name__ == "__main__":
    unittest.main()
