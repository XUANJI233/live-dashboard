import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const tempDir = mkdtempSync(join(tmpdir(), "live-controller-event-contract-"));
process.env.DB_PATH = join(tempDir, "test.db");
process.env.HASH_SECRET = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");

const { enqueueControllerEvent } = await import("../src/services/controller-event-outbox");
type ControllerEvent = import("../src/services/controller-webhook").ControllerEvent;

// The same fixture runs in deploy/hermes/tests/test_controller_event_contract.py.
const fixturePath = fileURLToPath(new URL("../../../deploy/hermes/tests/fixtures/controller_events.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8")) as {
  valid: Array<{ name: string; event: ControllerEvent }>;
  invalid: Array<{ name: string; event: ControllerEvent }>;
};

describe("Live to Hermes controller event contract", () => {
  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows keeps the SQLite file locked until the process exits.
    }
  });

  for (const { name, event } of fixture.valid) {
    test(`Live may send: ${name}`, () => {
      expect(enqueueControllerEvent(event)).not.toBe("invalid");
    });
  }

  for (const { name, event } of fixture.invalid) {
    test(`Live never sends: ${name}`, () => {
      expect(enqueueControllerEvent(event)).toBe("invalid");
    });
  }
});
