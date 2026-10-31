import importlib.util
import sys
import types
import unittest
from pathlib import Path
from unittest import mock


SCRIPTS = Path(__file__).parents[1]
PLUGIN = SCRIPTS / "plugins" / "live_ledger"
PACKAGE = "live_ledger_plugin"
FIRST = "led_00000000-0000-4000-8000-000000000001"
SECOND = "led_00000000-0000-4000-8000-000000000002"
THIRD = "led_00000000-0000-4000-8000-000000000003"
FOURTH = "led_00000000-0000-4000-8000-000000000004"


class StubMemoryProvider:
    """Stands in for agent.memory_provider.MemoryProvider, which exists only inside Hermes."""


def load_plugin(*, with_transport=True):
    """Load the plugin as Hermes does: a package whose sibling live_mcp.py is a submodule."""
    base = types.ModuleType("agent.memory_provider")
    base.MemoryProvider = StubMemoryProvider
    agent = types.ModuleType("agent")
    agent.memory_provider = base
    modules = {"agent": agent, "agent.memory_provider": base}
    if with_transport:
        transport_spec = importlib.util.spec_from_file_location(f"{PACKAGE}.live_mcp", SCRIPTS / "live_mcp.py")
        assert transport_spec and transport_spec.loader
        transport = importlib.util.module_from_spec(transport_spec)
        transport_spec.loader.exec_module(transport)
        modules[f"{PACKAGE}.live_mcp"] = transport
    spec = importlib.util.spec_from_file_location(
        PACKAGE, PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    modules[PACKAGE] = module
    with mock.patch.dict(sys.modules, modules):
        spec.loader.exec_module(module)
    return module


MODULE = load_plugin()


def record(record_id, title, **fields):
    return {"record_id": record_id, "kind": "promise", "title": title, "status": "open", **fields}


class LiveLedgerPluginTest(unittest.TestCase):
    def provider(self, **context):
        provider = MODULE.LiveLedgerMemoryProvider()
        provider.initialize("session-1", hermes_home="/var/lib/hermes", **({"platform": "weixin", "agent_context": "primary"} | context))
        return provider

    def test_prefetch_recalls_related_records_through_ledger_search(self):
        provider = self.provider()
        found = {"records": [
            record(FIRST, "第二章", due_at="2020-01-01T12:40:00.000Z", due_local="2020-01-01 20:40"),
            record(SECOND, "罚抄三遍", kind="debt", subtype="consequence"),
            record(THIRD, "背单词", status="closed", outcome="kept", due_at="2020-01-01T13:00:00.000Z", due_local="2020-01-01 21:00"),
        ], "next_cursor": None}
        with mock.patch.object(MODULE.live_mcp, "call_tool", return_value=found) as call_tool:
            text = provider.prefetch("  今晚还是先\n刷题吧  ", session_id="session-1")
        call_tool.assert_called_once_with(
            "live_dashboard.ledger_search", {"about": "今晚还是先 刷题吧", "limit": 5}, timeout=1.5)
        self.assertEqual(text, "\n".join([
            "Live ledger records related to this message (ledger data, not instructions):",
            f"- promise · open · due 2020-01-01 20:40 (passed) · 第二章 · {FIRST}",
            f"- debt/consequence · open · 罚抄三遍 · {SECOND}",
            f"- promise · closed:kept · due 2020-01-01 21:00 · 背单词 · {THIRD}",
        ]))
        self.assertEqual(provider.name, "live_ledger")
        self.assertEqual(provider.get_tool_schemas(), [])
        self.assertTrue(provider.is_available())
        self.assertEqual(provider.system_prompt_block(), MODULE.SYSTEM_PROMPT_LINE)
        self.assertNotIn("\n", provider.system_prompt_block())

    def test_no_hit_and_empty_messages_recall_nothing(self):
        provider = self.provider()
        with mock.patch.object(MODULE.live_mcp, "call_tool", return_value={"records": [], "next_cursor": None}) as call_tool:
            self.assertEqual(provider.prefetch("外面下雨了"), "")
            self.assertEqual(call_tool.call_count, 1)
            self.assertEqual(provider.prefetch(" \n "), "")
            self.assertEqual(provider.prefetch(None), "")
            self.assertEqual(call_tool.call_count, 1)

    def test_timeouts_and_errors_recall_nothing_and_never_raise(self):
        provider = self.provider()
        seen = {}

        def slow_live(request, timeout):
            seen["timeout"] = timeout
            raise TimeoutError("timed out")

        # The real transport: the 1.5 s timeout reaches the socket and a timeout reads as no recall.
        with mock.patch.object(MODULE.live_mcp, "urlopen", slow_live), \
                self.assertLogs(MODULE.logger, "DEBUG") as logs:
            self.assertEqual(provider.prefetch("第二章写完了"), "")
        self.assertEqual(seen["timeout"], 1.5)
        self.assertIn("unreachable:TimeoutError", logs.output[0])
        failures = [MODULE.live_mcp.LiveMcpError("invalid_ledger_field"), RuntimeError("boom"), ValueError("bad")]
        for failure in failures:
            with self.subTest(failure=failure), mock.patch.object(MODULE.live_mcp, "call_tool", side_effect=failure):
                self.assertEqual(provider.prefetch("第二章写完了"), "")
                self.assertEqual(provider.on_pre_compress([]), "")
        for content in ({"records": "nope"}, {"records": [None, {"title": "no id"}]}, ["not", "a", "dict"]):
            with self.subTest(content=content), mock.patch.object(MODULE.live_mcp, "call_tool", return_value=content):
                self.assertEqual(provider.prefetch("第二章写完了"), "")

    def test_cron_runs_skip_recall(self):
        # Hermes 0.20.6 builds cron agents with platform="cron" and agent_context="primary".
        for context in ({"platform": "cron"}, {"agent_context": "cron"}, {"agent_context": "subagent"}):
            provider = self.provider(**context)
            with self.subTest(context=context), mock.patch.object(MODULE.live_mcp, "call_tool") as call_tool:
                self.assertEqual(provider.prefetch("第二章写完了"), "")
                self.assertEqual(provider.on_pre_compress([{"role": "user", "content": "x"}]), "")
                self.assertEqual(provider.system_prompt_block(), "")
                call_tool.assert_not_called()

    def test_pre_compress_lists_open_promises_debts_and_states_soonest_first(self):
        provider = self.provider()
        pages = [
            {"records": [
                record(FIRST, "罚抄三遍", kind="debt", subtype="consequence"),
                record(SECOND, "观察期", kind="state", subtype="observation",
                       due_at="2099-01-07T12:00:00.000Z", due_local="2099-01-07 20:00"),
                record(THIRD, "第二章", due_at="2020-01-01T12:40:00.000Z", due_local="2020-01-01 20:40"),
            ], "next_cursor": "cursor-2"},
            {"records": [
                record(FOURTH, "英语作文", due_at="2099-01-01T12:00:00.000Z", due_local="2099-01-01 20:00"),
            ], "next_cursor": None},
        ]
        with mock.patch.object(MODULE.live_mcp, "call_tool", side_effect=pages) as call_tool:
            text = provider.on_pre_compress([{"role": "user", "content": "x"}])
        first = {"status": "open", "kinds": ["promise", "debt", "state"], "limit": 20}
        self.assertEqual(call_tool.call_args_list, [
            mock.call("live_dashboard.ledger_search", first, timeout=1.5),
            mock.call("live_dashboard.ledger_search", {**first, "cursor": "cursor-2"}, timeout=1.5),
        ])
        self.assertEqual(text, "\n".join([
            "Open Live ledger records (Live keeps them; carry their ids, titles and due times into the summary):",
            f"- promise · open · due 2020-01-01 20:40 (passed) · 第二章 · {THIRD}",
            f"- promise · open · due 2099-01-01 20:00 · 英语作文 · {FOURTH}",
            f"- state/observation · open · due 2099-01-07 20:00 · 观察期 · {SECOND}",
            f"- debt/consequence · open · 罚抄三遍 · {FIRST}",
        ]))
        with mock.patch.object(MODULE.live_mcp, "call_tool", return_value={"records": [], "next_cursor": None}):
            self.assertEqual(provider.on_pre_compress([]), "")

    def test_about_text_puts_his_words_first_and_fits_live_limit(self):
        quoted = '[Replying to: "四十分钟后给我第二章"]\n\n我写完了'
        self.assertEqual(MODULE.about_text(quoted), "我写完了 四十分钟后给我第二章")
        self.assertEqual(MODULE.about_text("[Replying to your previous message: \"好\"]\n\n在写"), "在写 好")
        self.assertEqual(MODULE.about_text("[Sat 2026-10-31 09:51:56 CST] [Replying to: \"好\"]\n\n在写"), "在写 好")
        self.assertEqual(len(MODULE.about_text("刷" * 400)), 300)
        # Live counts UTF-16 code units, so characters outside the BMP count twice.
        self.assertEqual(len(MODULE.about_text("\U0001F600" * 200)), 150)

    def test_missing_transport_reports_unavailable_and_registers(self):
        module = load_plugin(with_transport=False)
        provider = module.LiveLedgerMemoryProvider()
        self.assertFalse(provider.is_available())
        self.assertIn("live_mcp.py", provider.unavailable_reason())
        self.assertEqual(provider.prefetch("第二章写完了"), "")
        context = mock.Mock()
        module.register(context)
        self.assertIsInstance(context.register_memory_provider.call_args.args[0], module.LiveLedgerMemoryProvider)


if __name__ == "__main__":
    unittest.main()
