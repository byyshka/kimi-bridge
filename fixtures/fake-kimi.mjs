#!/usr/bin/env node
// Stands in for the Kimi Code CLI so the bridge's failure paths can be exercised without the real
// binary, a login or a network call. The bridge spawns it through KIMI_BRIDGE_ENTRY with the same
// arguments it would pass to the real CLI: --output-format stream-json [--session X] [--model Y]
// -p "<prompt>".
//
// The prompt text selects the behaviour, so one fixture covers every case.
//
// It is deliberately strict about the arguments it receives. A lenient stand-in answers "ok" no
// matter how it was invoked — with a missing -p it would even read the flag itself as the prompt —
// which would keep every test green after the bridge stopped passing the prompt at all.

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const fail = (reason) => {
  process.stderr.write(`fake-kimi: ${reason}\ngot: ${JSON.stringify(argv)}\n`);
  process.exit(64);
};

const formatAt = argv.indexOf("--output-format");

if (formatAt === -1 || argv[formatAt + 1] !== "stream-json") {
  fail("expected `--output-format stream-json`");
}

const promptAt = argv.indexOf("-p");

if (promptAt === -1) {
  fail("expected the prompt to be passed with -p");
}

const prompt = argv[promptAt + 1];

if (prompt === undefined || prompt.startsWith("--")) {
  fail("-p was given without a prompt after it");
}

const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);

if (prompt.includes("SPAWNCHILD")) {
  // A detached grandchild that deliberately outlives this process, the way the real CLI's children
  // do. Killing only the wrapper leaves it running; taskkill /T takes the whole tree. Its pid goes
  // to a file, because a timed-out call returns no output to read it from.
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });

  grandchild.unref();

  if (process.env.FIXTURE_PID_FILE) {
    writeFileSync(process.env.FIXTURE_PID_FILE, String(grandchild.pid), "utf8");
  }

  setTimeout(() => {}, 60_000);
} else if (prompt.includes("ECHOARGS")) {
  // Report the arguments back as the answer, so a test can prove that session, model and the rest
  // actually reach the CLI instead of being dropped on the way.
  emit({ role: "assistant", content: JSON.stringify(argv) });
  process.exit(0);
} else if (prompt.includes("HANG")) {
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
} else if (prompt.includes("SLOWANSWER")) {
  // Produce an answer, then hang: a timeout must not report this partial text as a clean result.
  emit({ role: "assistant", content: "partial answer" });
  setTimeout(() => {}, 60_000);
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
