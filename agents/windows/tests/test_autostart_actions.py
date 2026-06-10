import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import autostart_actions


class AutostartActionTests(unittest.TestCase):
    def setUp(self):
        self._original_is_enabled = autostart_actions.is_autostart_enabled
        self._original_remove_legacy = autostart_actions.remove_legacy_startup_task
        self._original_set_registry = autostart_actions.set_registry_autostart

    def tearDown(self):
        autostart_actions.is_autostart_enabled = self._original_is_enabled
        autostart_actions.remove_legacy_startup_task = self._original_remove_legacy
        autostart_actions.set_registry_autostart = self._original_set_registry

    def _wire_helpers(self, enabled: bool, registry_ok: bool = True, legacy_ok: bool = True):
        state = {"enabled": enabled}
        calls: list[tuple[str, bool | None]] = []

        def is_enabled() -> bool:
            return state["enabled"]

        def set_registry(value: bool) -> bool:
            calls.append(("registry", value))
            if registry_ok:
                state["enabled"] = value
            return registry_ok

        def remove_legacy() -> bool:
            calls.append(("legacy", None))
            return legacy_ok

        autostart_actions.is_autostart_enabled = is_enabled
        autostart_actions.set_registry_autostart = set_registry
        autostart_actions.remove_legacy_startup_task = remove_legacy
        return calls

    def test_toggle_enables_autostart(self):
        calls = self._wire_helpers(enabled=False)

        result = autostart_actions.toggle_autostart()

        self.assertTrue(result.enabled)
        self.assertTrue(result.ok)
        self.assertIn("已开启", result.message)
        self.assertEqual(calls, [("legacy", None), ("registry", True)])

    def test_enable_reports_legacy_cleanup_failure(self):
        self._wire_helpers(enabled=False, legacy_ok=False)

        result = autostart_actions.toggle_autostart()

        self.assertTrue(result.enabled)
        self.assertFalse(result.ok)
        self.assertIn("旧任务计划", result.message)

    def test_disable_reports_partial_cleanup_failure(self):
        self._wire_helpers(enabled=True, legacy_ok=False)

        result = autostart_actions.toggle_autostart()

        self.assertFalse(result.enabled)
        self.assertFalse(result.ok)
        self.assertIn("未能清理", result.message)


if __name__ == "__main__":
    unittest.main()
