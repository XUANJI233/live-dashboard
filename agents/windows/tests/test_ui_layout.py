import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ui_layout import overview_slots, settings_slots, text_wrap_width, use_two_columns


class UiLayoutTests(unittest.TestCase):
    def test_cards_use_one_column_when_content_is_narrow(self):
        self.assertFalse(use_two_columns(640))
        self.assertEqual(overview_slots(640)["config"].row, 1)
        self.assertEqual(settings_slots(640)["actions"].row, 3)

    def test_cards_use_two_columns_when_content_has_room(self):
        self.assertTrue(use_two_columns(900))
        self.assertEqual(overview_slots(900)["config"].column, 1)
        self.assertEqual(overview_slots(900)["actions"].columnspan, 2)
        self.assertEqual(settings_slots(900)["cadence"].column, 1)

    def test_text_wrap_width_stays_inside_readable_bounds(self):
        self.assertEqual(text_wrap_width(200), 260)
        self.assertEqual(text_wrap_width(2000), 720)
        self.assertEqual(text_wrap_width(520), 448)


if __name__ == "__main__":
    unittest.main()
