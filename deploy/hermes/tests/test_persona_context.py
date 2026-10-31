import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import yaml


ROOT = Path(__file__).parents[1]


def load_file(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PLUGIN = load_file("persona_context_plugin", ROOT / "plugins/persona_context/__init__.py")
CONFIG = load_file("configure_persona_context", ROOT / "configure_persona_context.py")


def scaffold(name, *, supporting=False):
    text = (
        f'[IMPORTANT: The "{name}" skill is auto-loaded. Follow its instructions for this session.]\n\n'
        f"# Legacy {name}\nlegacy body\n\n"
        "[Preloaded skill reference: references/voice.md]\nlegacy voice\n\n"
        f"[Skill directory: /profile/skills/{name}]\n"
        "Resolve any relative paths in this skill (e.g. `scripts/foo.js`, `templates/config.yaml`) "
        "against that directory, then run them with the terminal tool using the absolute path."
    )
    if supporting:
        text += (
            "\n\n[Skill config (from /profile/config.yaml):\n  level = strict\n]"
            "\n\n[Skill setup note: setup done]"
            "\n\n[This skill has supporting files (paths relative to the skill directory above):]\n"
            "- references/voice.md\n\nLoad any of these with skill_view(name=\"test\", "
            "file_path=\"<path>\"), or run scripts directly by absolute path "
            f"(e.g. `node /profile/skills/{name}/scripts/foo.js`)."
        )
    return text


def test_four_legacy_turns_fold_once_each_without_changing_human_text_or_stored_rows():
    user_text = "我写完了\n\n```python\nprint('这段要保留')\n```"
    old = scaffold("strict-study-girlfriend", supporting=True) + "\n\n" + scaffold("live-mentor")
    rows = [{"role": "system", "content": "current SOUL"}]
    for index in range(4):
        rows.extend([
            {"role": "user", "content": old + "\n\n" + user_text + str(index)},
            {"role": "assistant", "content": "我看过程"},
        ])
    request = {"messages": rows, "tools": [{"type": "function", "function": {"name": "skill_view"}}]}
    original = copy.deepcopy(request)
    result = PLUGIN.compact_persona_history(request, platform="weixin")
    assert request == original
    assert result["request"]["messages"][0] == rows[0]
    assert result["request"]["tools"] == request["tools"]
    for index in range(4):
        content = result["request"]["messages"][1 + index * 2]["content"]
        assert content.endswith(user_text + str(index))
        assert content.count("历史技能自动注入已折叠") == 1
        assert "legacy body" not in content
        assert "legacy voice" not in content
        assert "Skill directory" not in content
    assert PLUGIN.compact_persona_history(result["request"], platform="weixin") is None
    assert PLUGIN.compact_persona_history(request, platform="weixin") == result


def test_the_sticker_manual_folds_with_the_persona():
    names = ("strict-study-girlfriend", "live-mentor", "sticker-library")
    text = "\n\n".join(scaffold(name) for name in names) + "\n\n在吗"
    compact = PLUGIN.compact_legacy_text(text)
    assert compact.startswith(
        "[历史技能自动注入已折叠：strict-study-girlfriend, live-mentor, sticker-library；"
        "人设见系统提示，手册按需读取。]"
    )
    assert compact.endswith("\n\n在吗") and "legacy body" not in compact and "Skill directory" not in compact


def test_unrelated_skills_quotes_timestamps_and_incomplete_frames_are_retained():
    other = scaffold("weather")
    tail = "\n\n他问的是：\n\n别删我的段落"
    text = "[Sat 2026-10-31 09:51:56 CST] " + other + "\n\n" + scaffold("live-mentor") + tail
    compact = PLUGIN.compact_legacy_text(text)
    assert compact.startswith("[Sat 2026-10-31 09:51:56 CST] " + other)
    assert compact.endswith(tail)
    assert "legacy body" in compact  # only the unrelated skill's body survives
    incomplete = '[IMPORTANT: The "live-mentor" skill is auto-loaded. Follow its instructions for this session.]\n\n我自己的话'
    assert PLUGIN.compact_legacy_text(incomplete) == incomplete
    incomplete_then_other = incomplete + "\n\n" + other
    assert PLUGIN.compact_legacy_text(incomplete_then_other) == incomplete_then_other
    quoted = "这是一段引用：\n" + scaffold("live-mentor")
    assert PLUGIN.compact_legacy_text(quoted) == quoted


def test_structured_requests_keep_tool_pairs_images_cache_metadata_and_manual_results():
    legacy = scaffold("live-mentor") + "\n\n还有这个问题"
    rows = [
        {"role": "user", "content": [
            {"type": "text", "text": legacy, "cache_control": {"type": "ephemeral"}},
            {"type": "image", "source": {"type": "base64", "data": "image"}},
            {"type": "tool_result", "tool_use_id": "new_manual", "content": "current manual full text"},
        ]},
        {"role": "assistant", "tool_calls": [{"id": "read_1", "function": {"name": "skill_view"}}]},
        {"role": "tool", "tool_call_id": "read_1", "content": "current manual full text"},
    ]
    registered = {}
    PLUGIN.register(SimpleNamespace(register_middleware=lambda kind, callback: registered.update({kind: callback})))
    result = registered["llm_request"]({"input": rows, "instructions": "SOUL"}, platform="weixin")["request"]
    assert result["instructions"] == "SOUL"
    assert result["input"][0]["content"][0]["cache_control"] == {"type": "ephemeral"}
    assert result["input"][0]["content"][0]["text"].endswith("还有这个问题")
    assert result["input"][0]["content"][1:] == rows[0]["content"][1:]
    assert result["input"][1:] == rows[1:]
    assert PLUGIN.compact_persona_history({"messages": rows}, platform="cron") is None
    assert PLUGIN.compact_persona_history({"messages": [{"role": "user", "content": "普通聊天"}]}, platform="weixin") is None


def test_config_migration_disables_both_injection_paths_without_changing_schedules_or_other_skills():
    config = {
        "platforms": {"weixin": {"token": "keep", "dm_auto_skills": ["live-mentor"],
                                 "extra": {"dm_auto_skills": "strict-study-girlfriend", "other": True}}},
        "skills": {"auto_load": ["other-skill", "strict-study-girlfriend", " live-mentor "]},
        "plugins": {"enabled": ["other-plugin"], "disabled": ["persona_context", "disabled-plugin"]},
        "memory": {"provider": "live_ledger"},
        "cron": {"jobs": [{"name": "live-memory-sync", "enabled": False}]},
    }
    original = copy.deepcopy(config)
    updated = CONFIG.persona_config(config)
    assert config == original
    assert updated["platforms"]["weixin"]["dm_auto_skills"] == []
    assert updated["platforms"]["weixin"]["extra"] == {"dm_auto_skills": [], "other": True}
    assert updated["platforms"]["weixin"]["token"] == "keep"
    assert updated["skills"]["auto_load"] == ["other-skill"]
    assert updated["plugins"] == {"enabled": ["other-plugin", "persona_context"], "disabled": ["disabled-plugin"]}
    assert updated["cron"] == original["cron"]
    assert updated["memory"] == original["memory"]
    assert CONFIG.persona_config(updated) == updated


def test_config_file_migration_backs_up_the_original_and_is_idempotent(tmp_path):
    path = tmp_path / "config.yaml"
    original = "memory:\n  provider: live_ledger\nplatforms:\n  weixin:\n    enabled: true\n"
    path.write_text(original, encoding="utf-8")
    assert CONFIG.configure_file(path, yaml_api=yaml) is True
    written = path.read_bytes()
    assert yaml.safe_load(written)["platforms"]["weixin"]["enabled"] is True
    assert path.with_suffix(".yaml.persona-context.bak").read_text(encoding="utf-8") == original
    assert CONFIG.configure_file(path, yaml_api=yaml) is False
    assert path.read_bytes() == written
