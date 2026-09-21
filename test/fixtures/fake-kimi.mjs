#!/usr/bin/env node
// Stands in for the Kimi Code CLI so the bridge's failure paths can be exercised without the real
// binary, a login or a network call. The bridge spawns it through KIMI_BRIDGE_ENTRY with the same
// arguments it would pass to the real CLI: --output-format stream-json [--session X] [--model Y]
// -p "<prompt>".
//
// The prompt text selects the behaviour, so one fixture covers every case.

const argv = process.argv.slice(2);
const prompt = argv[argv.indexOf("-p") + 1] ?? "";
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

if (prompt.includes("HANG")) {
  setTimeout(() => {}, 60_000);
} else if (prompt.includes("EMPTY")) {
  process.exit(0);
} else if (prompt.includes("NARRATION")) {
  // Narration, then a tool call, then the real answer. Only the last one is the answer.
  emit({ role: "assistant", content: "Читаю модуль целиком." });
  emit({ role: "assistant", tool_calls: [{ id: "1", function: { name: "Read", arguments: '{"path":"a.bsl"}' } }] });
  emit({ role: "tool", tool_call_id: "1", content: "module text" });
  emit({ role: "assistant", content: "Реквизит существует." });
  emit({ role: "meta", type: "session.resume_hint", session_id: "session_fixture" });
  process.exit(0);
} else if (prompt.includes("LIBUV")) {
  // A complete answer followed by a non-zero exit, which is what kimi-code does on Windows while
  // tearing down handles. The parsed answer must win over the exit status.
  emit({ role: "assistant", content: "answer before the crash" });
  process.exit(3);
} else if (prompt.includes("GARBAGE")) {
  process.stdout.write("this line is not json at all\n");
  emit({ role: "assistant", content: "ok" });
  process.exit(0);
} else {
  emit({ role: "assistant", content: "ok" });
  emit({ role: "meta", type: "session.resume_hint", session_id: "session_fixture" });
  process.exit(0);
}
