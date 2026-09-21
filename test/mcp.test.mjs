// Covers the MCP surface the calling agent sees, over the real protocol: which tools each profile
// advertises, a genuine tools/call, and the footer that tells the caller whether the answer was
// checked against anything.
//
// The profile split is the part worth guarding. A neutral profile that still advertised
// metadata verification would present an answer from memory as a verified one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "..", "index.mjs");
const fixture = path.join(here, "..", "fixtures", "fake-kimi.mjs");

function talk(requests, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [server], {
      env: {
        ...process.env,
        KIMI_BRIDGE_ENTRY: fixture,
        KIMI_BRIDGE_LOG: "0",
        ...extraEnv,
      },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`server did not answer in time; output so far: ${stdout}`));
    }, 30_000);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);

      resolve(
        stdout
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return null;
            }
          })
          .filter(Boolean),
      );
    });

    for (const request of requests) {
      child.stdin.write(`${JSON.stringify(request)}\n`);
    }

    child.stdin.end();
  });
}

const handshake = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } },
  },
  { jsonrpc: "2.0", method: "notifications/initialized" },
];

const listTools = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const answerTo = (messages, id) => messages.find((message) => message.id === id);

test("the default profile advertises both tools", async () => {
  const messages = await talk([...handshake, listTools]);

  assert.deepEqual(
    answerTo(messages, 2)
      .result.tools.map((tool) => tool.name)
      .sort(),
    ["kimi_ask", "kimi_review"],
  );
});

test("the neutral profile advertises kimi_ask alone", async () => {
  const messages = await talk([...handshake, listTools], { KIMI_BRIDGE_PROFILE: "neutral" });

  assert.deepEqual(
    answerTo(messages, 2).result.tools.map((tool) => tool.name),
    ["kimi_ask"],
  );
});

test("the two profiles describe kimi_ask differently", async () => {
  // Identical descriptions are the failure mode: a toolless profile promising metadata checks.
  const [tooled, neutral] = await Promise.all([
    talk([...handshake, listTools]),
    talk([...handshake, listTools], { KIMI_BRIDGE_PROFILE: "neutral" }),
  ]);

  const describe = (messages) =>
    answerTo(messages, 2).result.tools.find((tool) => tool.name === "kimi_ask").description;

  assert.notEqual(describe(tooled), describe(neutral));
  assert.match(describe(neutral), /CANNOT|no MCP|own knowledge/i);
});

test("a tools/call returns the answer with the tool summary appended", async () => {
  const messages = await talk([
    ...handshake,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "kimi_ask", arguments: { prompt: "NARRATION", cwd: here } },
    },
  ]);

  const text = answerTo(messages, 3).result.content[0].text;

  assert.match(text, /Реквизит существует\./);
  assert.match(text, /Kimi called 1 tool/);
  assert.match(text, /session_id: session_fixture/);
});

test("an answer produced without tools says so outright", async () => {
  const messages = await talk([
    ...handshake,
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "kimi_ask", arguments: { prompt: "say ok", cwd: here } },
    },
  ]);

  assert.match(answerTo(messages, 3).result.content[0].text, /Kimi called NO tools/);
});

test("a call missing the required prompt is rejected by the schema", async () => {
  const messages = await talk([
    ...handshake,
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "kimi_ask", arguments: {} } },
  ]);

  const answer = answerTo(messages, 3);

  assert.ok(answer, "the server must answer a malformed call rather than stay silent");
  assert.match(JSON.stringify(answer).toLowerCase(), /prompt|required|invalid/);
});
