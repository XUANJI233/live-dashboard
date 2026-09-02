import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "usage_summary.py"
SPEC = importlib.util.spec_from_file_location("usage_summary", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class UsageSummaryTest(unittest.TestCase):
    def test_groups_one_local_day_without_enforcing_a_budget(self):
        result = MODULE.summarize_usage([
            {"ts": "2026-09-01T16:30:00Z", "job_id": "a", "prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110, "response_silent": True},
            {"ts": "2026-09-02T01:00:00Z", "job_id": "a", "prompt_tokens": 200, "completion_tokens": 20, "total_tokens": 220, "response_silent": False},
            {"ts": "2026-09-02T16:30:00Z", "job_id": "a", "total_tokens": 999},
        ], {"a": "followup"}, "2026-09-02")

        self.assertEqual(result["total_tokens"], 330)
        self.assertEqual(result["calls"], 2)
        self.assertEqual(result["jobs"][0]["name"], "followup")
        self.assertEqual(result["jobs"][0]["silent_calls"], 1)


if __name__ == "__main__":
    unittest.main()
