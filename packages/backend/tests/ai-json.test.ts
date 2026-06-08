import { describe, expect, test } from "bun:test";
import { parseAiJsonObject } from "../src/services/ai-json";

describe("ai-json", () => {
  test("parses fenced JSON objects", () => {
    expect(parseAiJsonObject("```json\n{\"deviated\":false,\"reason\":\"ok\"}\n```")).toEqual({
      deviated: false,
      reason: "ok",
    });
  });

  test("unwraps JSON strings with escaped quotes", () => {
    const raw = JSON.stringify("{\"deviated\":true,\"message\":\"回到目标\"}");
    expect(parseAiJsonObject(raw)).toMatchObject({
      deviated: true,
      message: "回到目标",
    });
  });

  test("extracts balanced object without being confused by braces inside strings", () => {
    const raw = "说明 {不是 json}\n{\"reason\":\"标题里有 { 大括号 } 和 \\\"引号\\\"\",\"freeze\":false}";
    expect(parseAiJsonObject(raw)).toEqual({
      reason: "标题里有 { 大括号 } 和 \"引号\"",
      freeze: false,
    });
  });

  test("throws when no JSON object exists", () => {
    expect(() => parseAiJsonObject("no json here")).toThrow("AI response did not contain a JSON object");
  });
});
