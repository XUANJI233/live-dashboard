import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ui_theme import ACCENT, ERROR, SUCCESS, TEXT, WARNING, notice_palette, status_color


class UiThemeTests(unittest.TestCase):
    def test_status_color_uses_semantic_tones(self):
        self.assertEqual(status_color("在线"), SUCCESS)
        self.assertEqual(status_color("AFK"), WARNING)
        self.assertEqual(status_color("配置错误"), ERROR)
        self.assertEqual(status_color("初始化中"), TEXT)

    def test_notice_palette_distinguishes_info_and_error(self):
        self.assertEqual(notice_palette(False)["title"], ACCENT)
        self.assertEqual(notice_palette(True)["title"], ERROR)


if __name__ == "__main__":
    unittest.main()
