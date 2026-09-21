// The reason this bridge is Windows-only in the first place: the Kimi CLI spawns children of its own, and
// killing the wrapper leaves them running with an API session still open. Windows has no process
// group to signal, so the code goes through taskkill /T — and that is what this file checks, with
// a real detached grandchild rather than by reading the source.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runKimi } from "../index.mjs";

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "fake-kimi.mjs");
const saved = {};
let temp;

before(() => {
  saved.bin = process.env.KIMI_BRIDGE_ENTRY;
  saved.pidFile = process.env.FIXTURE_PID_FILE;

  temp = mkdtempSync(path.join(os.tmpdir(), "bridge-tree-"));
  process.env.KIMI_BRIDGE_ENTRY = fixture;
  process.env.FIXTURE_PID_FILE = path.join(temp, "grandchild.pid");
});

after(() => {
  for (const [key, name] of [
    ["bin", "KIMI_BRIDGE_ENTRY"],
    ["pidFile", "FIXTURE_PID_FILE"],
  ]) {
    if (saved[key] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved[key];
    }
  }

  rmSync(temp, { recursive: true, force: true });
});

// signal 0 performs the permission and existence check without actually signalling.
function isAlive(pid) {
  try {
    process.kill(pid, 0);

    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

async function waitUntilGone(pid, ms = 5000) {
  const deadline = Date.now() + ms;

  while (Date.now() < deadline) {
    if (!isAlive(pid)) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return !isAlive(pid);
}

test("a timeout kills the whole tree, not just the process that was spawned", async () => {
  await assert.rejects(
    () => runKimi({ prompt: "SPAWNCHILD", cwd: process.cwd(), timeoutSec: 1 }),
    /killed by the 1s timeout/,
  );

  const pidFile = process.env.FIXTURE_PID_FILE;

  assert.ok(existsSync(pidFile), "the fixture did not record a grandchild pid");

  const pid = Number(readFileSync(pidFile, "utf8").trim());

  assert.ok(Number.isInteger(pid) && pid > 0, `unusable pid: ${pid}`);

  const gone = await waitUntilGone(pid);

  if (!gone) {
    // Leave nothing running behind a failing assertion.
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }

  assert.ok(gone, `the grandchild (pid ${pid}) survived the timeout — the tree was not killed`);
});
