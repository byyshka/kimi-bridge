// Exercises the paths that cannot be checked by reading the code: timeout, empty answer, and the
// deliberate decision to trust a parsed answer over a non-zero exit code. The real CLI is replaced
// through KIMI_BRIDGE_ENTRY by a fixture, so these run offline and without a login.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runKimi } from "../index.mjs";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-kimi.mjs");
let savedEntry;

before(() => {
  savedEntry = process.env.KIMI_BRIDGE_ENTRY;
  process.env.KIMI_BRIDGE_ENTRY = fixture;
});

after(() => {
  if (savedEntry === undefined) {
    delete process.env.KIMI_BRIDGE_ENTRY;
  } else {
    process.env.KIMI_BRIDGE_ENTRY = savedEntry;
  }
});

const call = (prompt, timeoutSec = 30) => runKimi({ prompt, cwd: process.cwd(), timeoutSec });

test("a normal run returns the answer and the session id", async () => {
  const result = await call("say ok");

  assert.equal(result.answer, "ok");
  assert.equal(result.sessionId, "session_fixture");
});

test("narration is not mistaken for the answer, and tool calls are reported", async () => {
  const result = await call("NARRATION");

  assert.equal(result.answer, "Реквизит существует.");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0].name, "Read");
});

test("a timeout rejects instead of returning a truncated answer", async () => {
  await assert.rejects(() => call("HANG", 1), /killed by the 1s timeout/);
});

test("an empty answer rejects rather than passing an empty string on", async () => {
  await assert.rejects(() => call("EMPTY"), /returned no answer/);
});

test("a parsed answer wins over a non-zero exit code", async () => {
  // kimi-code trips a libuv assertion on Windows after the answer is already on stdout.
  const result = await call("LIBUV");

  assert.equal(result.answer, "answer before the crash");
  assert.equal(result.exitCode, 3);
});

test("a malformed line is counted, not fatal", async () => {
  const result = await call("GARBAGE");

  assert.equal(result.answer, "ok");
  assert.ok(result.unknown.length >= 1);
});

test("an over-long prompt is refused before anything is spawned", async () => {
  await assert.rejects(() => call("x".repeat(28001)), /over the 28000 limit/);
});
