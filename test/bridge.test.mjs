import { test } from "node:test";
import assert from "node:assert/strict";

import { parseStreamJson, resolveKimiEntry } from "../index.mjs";

const line = (record) => `${JSON.stringify(record)}\n`;

test("the answer is the assistant text following the last tool call", () => {
  const stdout = [
    line({ role: "assistant", content: "Читаю модуль целиком." }),
    line({ role: "assistant", tool_calls: [{ id: "1", function: { name: "Read", arguments: '{"path":"a.bsl"}' } }] }),
    line({ role: "tool", tool_call_id: "1", content: "module text" }),
    line({ role: "assistant", content: "Реквизит существует." }),
  ].join("");

  const parsed = parseStreamJson(stdout);

  assert.equal(parsed.answer, "Реквизит существует.");
  assert.equal(parsed.toolCalls.length, 1);
  assert.equal(parsed.toolCalls[0].name, "Read");
});

test("narration before any tool call is not mistaken for the answer", () => {
  const stdout = [
    line({ role: "assistant", content: "Сейчас посмотрю." }),
    line({ role: "assistant", tool_calls: [{ id: "1", function: { name: "Grep", arguments: "{}" } }] }),
    line({ role: "tool", tool_call_id: "1", content: "hit" }),
    line({ role: "assistant", content: "Готово." }),
  ].join("");

  assert.equal(parseStreamJson(stdout).answer, "Готово.");
});

test("an answer with no tool calls is still returned, with an empty call list", () => {
  const parsed = parseStreamJson(line({ role: "assistant", content: "Токио" }));

  assert.equal(parsed.answer, "Токио");
  assert.equal(parsed.toolCalls.length, 0);
});

test("the resume hint is picked up as session_id", () => {
  const stdout = [
    line({ role: "assistant", content: "ok" }),
    line({ role: "meta", type: "session.resume_hint", session_id: "session_abc" }),
  ].join("");

  assert.equal(parseStreamJson(stdout).sessionId, "session_abc");
});

test("malformed lines are counted rather than throwing", () => {
  const stdout = `not json at all\n${line({ role: "assistant", content: "ok" })}`;
  const parsed = parseStreamJson(stdout);

  assert.equal(parsed.answer, "ok");
  assert.ok(parsed.unknown.length >= 1);
});

test("KIMI_BRIDGE_ENTRY pointing at a missing file fails with that path named", () => {
  const previous = process.env.KIMI_BRIDGE_ENTRY;

  process.env.KIMI_BRIDGE_ENTRY = "/definitely/not/here/main.mjs";

  try {
    assert.throws(() => resolveKimiEntry(), /KIMI_BRIDGE_ENTRY points at a missing file/);
  } finally {
    if (previous === undefined) {
      delete process.env.KIMI_BRIDGE_ENTRY;
    } else {
      process.env.KIMI_BRIDGE_ENTRY = previous;
    }
  }
});
