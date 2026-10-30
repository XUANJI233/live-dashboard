import re
from pathlib import Path


SKILLS = Path(__file__).parents[1] / "skills"
# Hermes agent/skill_commands.py silently skips a preload reference over 32 KiB, or once the
# declared references pass 64 KiB together. A skipped file never reaches the model.
FILE_LIMIT = 32 * 1024
TOTAL_LIMIT = 64 * 1024


def declared_preloads(skill: Path) -> list[str]:
    text = (skill / "SKILL.md").read_text(encoding="utf-8")
    front = text.split("---", 2)[1]
    block = re.search(r"preload_references:\n((?:\s+- .+\n)+)", front)
    return re.findall(r"- (.+)", block.group(1)) if block else []


def test_every_declared_preload_fits_the_hermes_budget():
    checked = 0
    for skill in sorted(path for path in SKILLS.iterdir() if (path / "SKILL.md").is_file()):
        total = 0
        for relative in declared_preloads(skill):
            # Hermes counts bytes on disk; the deployed copies are LF.
            size = len((skill / relative.strip()).read_bytes().replace(b"\r\n", b"\n"))
            assert size <= FILE_LIMIT, f"{skill.name}/{relative} is {size} bytes"
            total += size
            checked += 1
        assert total <= TOTAL_LIMIT, f"{skill.name} preloads {total} bytes"
    assert checked >= 2
