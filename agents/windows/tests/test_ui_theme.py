import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ui_theme import ACCENT, ERROR, SUCCESS, TEXT, WARNING, notice_palette, status_color, status_tone, tone_palette
from ui_components import TAB_BY_KEY, TAB_SPECS


class UiThemeTests(unittest.TestCase):
    def test_status_color_uses_semantic_tones(self):
        self.assertEqual(status_color("在线"), SUCCESS)
        self.assertEqual(status_color("AFK"), WARNING)
        self.assertEqual(status_color("配置错误"), ERROR)
        self.assertEqual(status_color("初始化中"), TEXT)

    def test_notice_palette_distinguishes_info_and_error(self):
        self.assertEqual(notice_palette(False)["title"], ACCENT)
        self.assertEqual(notice_palette(True)["title"], ERROR)

    def test_status_tone_matches_status_color_semantics(self):
        self.assertEqual(status_tone("在线"), "good")
        self.assertEqual(status_tone("AFK"), "warn")
        self.assertEqual(status_tone("配置错误"), "bad")
        self.assertEqual(status_tone("初始化中"), "neutral")

    def test_tone_palette_falls_back_to_neutral(self):
        self.assertEqual(tone_palette("good")["text"], SUCCESS)
        self.assertEqual(tone_palette("missing"), tone_palette("neutral"))

    def test_tab_specs_match_mobile_information_architecture(self):
        self.assertEqual([tab.key for tab in TAB_SPECS], ["overview", "messages", "settings"])
        self.assertEqual(TAB_BY_KEY["overview"].title, "概览")


if __name__ == "__main__":
    unittest.main()
