import importlib.util
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


SCRIPT = Path(__file__).parents[1] / "configure_cron_efficiency.py"
SPEC = importlib.util.spec_from_file_location("configure_cron_efficiency", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ConfigureCronEfficiencyTest(unittest.TestCase):
    def test_replaces_prompts_and_removes_self_continuity_without_touching_enabled_state(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            for filename in MODULE.PROMPT_FILES.values():
                (root / filename).write_text(f"prompt:{filename}", encoding="utf-8")
            updates = []

            changed = MODULE.configure_jobs(
                root,
                lambda name: {"id": f"id:{name}", "name": name},
                lambda job_id, values: updates.append((job_id, values)) or {"id": job_id},
            )

        self.assertEqual(set(changed), set(MODULE.PROMPT_FILES))
        self.assertTrue(all(values["context_from"] is None for _, values in updates))
        self.assertTrue(all("enabled" not in values for _, values in updates))
        self.assertTrue(all(job_id.startswith("id:") for job_id, _ in updates))


if __name__ == "__main__":
    unittest.main()
