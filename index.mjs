#!/usr/bin/env node
// kimi-bridge — exposes the locally installed Kimi Code CLI to Claude Code as MCP tools.
//
// Design notes (Windows-specific, deliberate):
//   * We spawn the CLI's dist/main.mjs through node.exe instead of the `kimi` shim.
//     The shim is a .cmd/.ps1 wrapper, which would force shell:true and break
//     argv escaping for prompts containing quotes, newlines or Cyrillic.
//   * Exit codes are not trusted. kimi-code trips a libuv assertion on Windows
//     while tearing down handles ("UV_HANDLE_CLOSING", src\win\async.c). That fires
//     after the answer is already on stdout, so a parsed answer wins over exit status.
//
// Observability: the tool calls Kimi made are summarized back into every answer — without that
// summary a claim like "the attribute exists" is indistinguishable from a guess. A fuller record
// (prompt, answer, timings) goes to logs/YYYY-MM-DD.jsonl only when KIMI_BRIDGE_LOG=1, since those
// fields hold whatever the caller was working on.
//
// No background-job layer here, on purpose. v0.4.0 grew kimi_start/kimi_result/kimi_jobs
// on a file-backed registry; an audit found three blockers in it and, worse, that its
// premise was false — killing the bridge kills the child, so nothing "survives a restart".
// Claude Code already backgrounds any main-conversation tool call that runs past two
// minutes (v2.1.212+), notifies on completion, and lists it in /tasks. The stdio idle
// window is 30 minutes, comfortably above the ~11 minutes a full module review takes.
// Parallelism comes from issuing several tool calls in one message. Reimplementing that
// here bought nothing and cost 200 lines of code that could silently report a killed job
// as a finished one.

import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Read the version rather than repeating it: a copy in the source silently drifts from package.json.
const { version: VERSION } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_REVIEW_TIMEOUT_SEC = 1500;
const MAX_PROMPT_CHARS = 28000; // argv ceiling on Windows is 32767 for the whole command line
const LOG_DIR = process.env.KIMI_BRIDGE_LOG_DIR || path.join(import.meta.dirname, "logs");

// Off by default: the log records prompts and answers verbatim, which on someone else's machine
// means their data on disk without them ever asking for it. Opt in with KIMI_BRIDGE_LOG=1.
const LOGGING_ENABLED = process.env.KIMI_BRIDGE_LOG === "1";

// One binary serves two roles, told apart by KIMI_BRIDGE_PROFILE: the default one assumes Kimi has
// MCP servers of its own, "neutral" assumes it has none.
//
// This flag changes only what this server advertises — its name, its descriptions, and whether
// kimi_review is registered. Which MCP servers Kimi actually has is decided by KIMI_CODE_HOME,
// inherited by the child process, so a neutral profile must be registered with its own
// KIMI_CODE_HOME pointing at a home whose mcp.json is empty. Setting the profile alone changes the
// advertising, not the tools.
//
// The descriptions are what a calling agent picks by, so they must NOT be identical across the
// two. A description promising metadata verification, sitting in front of a Kimi that has no tools
// at all, is exactly how an answer from memory gets read as a checked one.
const IS_NEUTRAL_PROFILE = process.env.KIMI_BRIDGE_PROFILE === "neutral";

function resolveKimiEntry() {
  const override = process.env.KIMI_BRIDGE_ENTRY;

  if (override) {
    if (!existsSync(override)) {
      throw new Error(`KIMI_BRIDGE_ENTRY points at a missing file: ${override}`);
    }

    return override;
  }

  const tail = path.join("@moonshot-ai", "kimi-code", "dist", "main.mjs");
  const candidates = [];

  // Derive the global node_modules from the running node. A hardcoded %APPDATA%\npm or
  // /usr/local only covers a default install; under nvm, fnm or volta the global root moves with
  // the active Node version, and this follows it.
  const nodeDir = path.dirname(process.execPath);

  if (process.platform === "win32") {
    candidates.push(path.join(nodeDir, "node_modules", tail));

    if (process.env.APPDATA) {
      candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", tail));
    }
  } else {
    candidates.push(path.join(path.dirname(nodeDir), "lib", "node_modules", tail));
    candidates.push(path.join("/usr/local/lib/node_modules", tail));
  }

  const home = process.env.HOME || process.env.USERPROFILE;

  if (home) {
    candidates.push(path.join(home, ".kimi-code", "dist", "main.mjs"));
    candidates.push(path.join(home, ".local", "lib", "kimi-code", "dist", "main.mjs"));
    candidates.push(path.join(home, ".local", "lib", "node_modules", tail));
  }

  const found = [...new Set(candidates)].find((candidate) => existsSync(candidate));

  if (!found) {
    throw new Error(
      "Kimi Code CLI entrypoint not found. Looked in:\n" +
        [...new Set(candidates)].map((candidate) => `  ${candidate}`).join("\n") +
        "\n" +
        "Install it with `npm i -g @moonshot-ai/kimi-code`, or set KIMI_BRIDGE_ENTRY to dist/main.mjs.",
    );
  }

  return found;
}

// stream-json is NDJSON. Record shapes confirmed against kimi-code 0.31.1:
//   {"role":"assistant","tool_calls":[{"id","function":{"name","arguments"}}]}  — note: no content field
//   {"role":"tool","tool_call_id":"...","content":"...tool output..."}
//   {"role":"assistant","content":"...narration or final answer..."}
//   {"role":"meta","type":"session.resume_hint","session_id":"session_..."}
//
// Kimi narrates while it works: "Читаю модуль целиком.", "Проверю типовой код." — each is its
// own assistant record with content, indistinguishable by shape from the real answer. Measured
// on a real 11-minute review: 6 assistant records, 5 of them narration of 36-259 chars, and one
// actual 7412-char analysis. Concatenating them all was a real defect — narration leaked into
// the top of every answer.
//
// The final answer is whatever the model says AFTER its last tool call. That boundary is
// structural, so it survives both extra narration and an answer split across records.
export function parseStreamJson(stdout) {
  const assistantTexts = [];
  const progressNotes = [];
  const toolCalls = [];
  const unknown = [];
  let lastToolIndex = -1;
  let toolResults = 0;
  let sessionId = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed) {
      continue;
    }

    let record;

    try {
      record = JSON.parse(trimmed);
    } catch {
      unknown.push(trimmed.slice(0, 500));
      continue;
    }

    if (record.role === "assistant" && Array.isArray(record.tool_calls)) {
      for (const call of record.tool_calls) {
        toolCalls.push({
          name: call?.function?.name ?? "(unnamed)",
          args: call?.function?.arguments ?? "",
        });
      }

      // Measured on kimi-code 0.31.1: narration rides along WITH the tool call
      // ("Читаю модуль целиком." + Read), while the final answer is the one assistant
      // record carrying no tool_calls. Keep the narration for the log, out of the answer.
      if (typeof record.content === "string" && record.content.trim()) {
        progressNotes.push(record.content);
      }

      lastToolIndex = assistantTexts.length - 1;
    } else if (record.role === "assistant" && typeof record.content === "string") {
      assistantTexts.push(record.content);
    } else if (record.role === "tool") {
      toolResults += 1;
      lastToolIndex = assistantTexts.length - 1;
    } else if (record.role === "meta") {
      if (typeof record.session_id === "string") {
        sessionId = record.session_id;
      }
    } else {
      unknown.push(trimmed.slice(0, 500));
    }
  }

  const answerParts = assistantTexts.slice(lastToolIndex + 1);

  return {
    answer: answerParts.join("\n").trim(),
    // Diagnostic only. Kimi sometimes prefaces the answer with one more line of narration
    // ("Формирую разбор.") AFTER its last tool call, where the structural boundary cannot
    // tell it apart. If this is consistently >1 with a short first part, tightening the rule
    // to "last record only" is safe; if it is 1, the narration shares a record with the
    // answer and no parser change can help. Measure before changing anything.
    answerPartLengths: answerParts.map((part) => part.length),
    progressNotes: [...progressNotes, ...assistantTexts.slice(0, lastToolIndex + 1)],
    toolCalls,
    toolResults,
    sessionId,
    unknown,
  };
}

// Turns '{"path":"package.json"}' into 'path=package.json' so the summary stays
// readable on one line. Falls back to the raw string when it is not JSON.
function summarizeArgs(rawArgs) {
  if (!rawArgs) {
    return "";
  }

  let parsed;

  try {
    parsed = JSON.parse(rawArgs);
  } catch {
    return rawArgs.length > 80 ? `${rawArgs.slice(0, 80)}…` : rawArgs;
  }

  if (parsed === null || typeof parsed !== "object") {
    return String(parsed).slice(0, 80);
  }

  const pairs = Object.entries(parsed).map(([key, value]) => {
    const flat = typeof value === "string" ? value : JSON.stringify(value);
    const text = flat ?? "";

    return `${key}=${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
  });

  const joined = pairs.join(", ");

  return joined.length > 140 ? `${joined.slice(0, 140)}…` : joined;
}

function writeLog(entry) {
  if (!LOGGING_ENABLED) {
    return;
  }

  // Logging must never break a call that otherwise succeeded.
  try {
    mkdirSync(LOG_DIR, { recursive: true });

    const day = new Date().toISOString().slice(0, 10);

    appendFileSync(path.join(LOG_DIR, `${day}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");
  } catch (error) {
    console.error(`kimi-bridge: failed to write log: ${error.message}`);
  }
}

// Real 1C modules run to tens of kilobytes. Pushing them through the caller's context
// as inline text is wasteful when Kimi has a 1M window and a Read tool of its own —
// so files are named, not pasted.
function buildFilesBlock(files) {
  if (!files?.length) {
    return "";
  }

  const list = files.map((file) => `- \`${file}\``).join("\n");

  return `## Файлы

Прочитай каждый из них целиком СВОИМ инструментом чтения — содержимое здесь не приведено:

${list}
`;
}

// The review prompt is assembled here, not by the caller. Anthropic's multi-agent
// write-up lands on four mandatory blocks for a subagent brief — goal, output format,
// what to verify with, task boundaries — and a brief missing any of them degrades
// quietly rather than failing. Leaving that to caller discipline means the target
// configuration eventually leaks out of the prompt with nobody noticing.
//
// Neutral phrasing is deliberate: a brief that names the suspected culprit gets
// confirmation instead of verification.
function buildReviewPrompt({ subject, target, focus, files, known, budgetToolCalls }) {
  const focusBlock = focus
    ? `## На что смотреть в первую очередь\n${focus}\n\nОстальное — по ходу, но приоритет за этим.`
    : "## На что смотреть\nБез заданного приоритета: корректность, производительность, транзакции и блокировки, соответствие стандартам 1С.";

  // Without this, Kimi re-verifies things the caller already knows to work and burns its
  // budget on them. Measured on the same module: without known_good it spent 14 tool calls
  // and produced a "concern"; with it, 5 calls and a genuine blocker.
  const knownBlock = known
    ? `## Уже проверено на практике — заново не проверяй\n${known}\n\nСчитай это данностью и трать бюджет на другое.`
    : "";

  const subjectBlock = subject ? `## Предмет разбора\n\n${subject}\n` : "";

  return `Ты выступаешь независимым ревьюером кода 1С (BSL). Твой разбор пойдёт другому агенту, который будет по нему принимать решения, поэтому важнее точность, чем полнота.

## Целевая среда
${target}

Всё, что ты утверждаешь про метаданные, должно относиться именно к этой среде. Если для ответа тебе нужна другая база или конфигурация — скажи об этом прямо, не подставляй похожую.

${focusBlock}

${knownBlock}

## Чем проверять
У тебя есть MCP-инструменты: графы метаданных, поиск по коду, синтакс-чекер, поиск по БСП и ИТС. Существование любого объекта метаданных, реквизита, регистра или метода БСП проверяй инструментом, а не по памяти — имена в типовых конфигурациях меняются между версиями. Бюджет: не более ${budgetToolCalls} вызовов инструментов. Если бюджет кончился, а что-то осталось непроверенным — не додумывай, вынеси это в секцию «Не смог проверить».

## Границы задачи
- Разбирай только указанный ниже код. Соседний код, архитектуру подсистемы и чужие модули не трогай.
- Ничего не переписывай и не правь файлы. Твой результат — findings, а не изменения.
- Стилистические придирки не нужны, если они не влияют на поведение, производительность или сопровождение.
- Не предлагай решений, которые требуют знания договорённостей с заказчиком, — ты их не видишь.

## Формат ответа — строго эти четыре секции

### Вердикт
Одно слово: ok / concern / blocker. Плюс одна фраза почему.

### Находки
Для каждой находки одним блоком:
- **Где** — процедура/функция и строка, если определимо
- **Что** — суть дефекта одной фразой
- **Серьёзность** — blocker / major / minor
- **Чем подтверждено** — конкретный инструмент и что он вернул, либо «рассуждение» если инструментом не проверялось
Если находок нет — так и напиши, не выдумывай.

### Подтверждено инструментами
Перечисли, что именно ты проверил и чем. Если инструменты не вызывал — напиши «инструменты не вызывались».

### Не смог проверить
Что осталось неподтверждённым и почему. Эта секция обязательна: если всё подтверждено — напиши «нет». Пустой её не оставляй.

${buildFilesBlock(files)}
${subjectBlock}`;
}

function buildAskPrompt({ prompt, files }) {
  const filesBlock = buildFilesBlock(files);

  return filesBlock ? `${filesBlock}\n${prompt}` : prompt;
}

// Children still running, so they can be cleaned up if this server goes down mid-call.
const liveChildren = new Set();

// child.kill() signals only the node wrapper we spawned; Kimi starts its own children, and those
// survive as orphans. Windows has no process group to signal, so the tree goes through taskkill /T.
function killTree(child) {
  if (!child.pid) {
    return;
  }

  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });

      return;
    } catch {
      // taskkill can fail if the process already exited — fall through to the direct kill.
    }
  }

  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
}

function killAllChildren() {
  for (const child of liveChildren) {
    killTree(child);
  }
}

// On "exit" only synchronous cleanup is possible, and calling process.exit there would recurse.
process.on("exit", killAllChildren);

// A signal handler replaces the default action, so the process would otherwise keep running and
// ignore Ctrl+C. Clean up, then exit with the conventional 128 + signal number.
process.on("SIGINT", () => {
  killAllChildren();
  process.exit(130);
});

process.on("SIGTERM", () => {
  killAllChildren();
  process.exit(143);
});

function runKimi({ prompt, cwd, sessionId, timeoutSec, model }) {
  if (prompt.length > MAX_PROMPT_CHARS) {
    return Promise.reject(
      new Error(
        `Prompt is ${prompt.length} chars, over the ${MAX_PROMPT_CHARS} limit. The CLI takes it ` +
          "through argv, and Windows caps a command line at 32767. Pass files by path in `files` " +
          "instead of pasting their contents — Kimi opens them itself.",
      ),
    );
  }

  const entry = resolveKimiEntry();
  const args = [entry, "--output-format", "stream-json"];

  if (sessionId) {
    args.push("--session", sessionId);
  }

  if (model) {
    args.push("--model", model);
  }

  args.push("-p", prompt);

  const workingDir = cwd || process.cwd();
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: workingDir,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    liveChildren.add(child);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutSec * 1000);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const baseLog = () => ({
      ts: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      cwd: workingDir,
      model: model || "(default)",
      resumed_session: sessionId || null,
      prompt,
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      liveChildren.delete(child);
      writeLog({ ...baseLog(), status: "spawn_error", error: error.message });
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      liveChildren.delete(child);

      const parsed = parseStreamJson(stdout);
      const log = {
        ...baseLog(),
        session_id: parsed.sessionId,
        exit_code: code,
        timed_out: timedOut,
        tool_calls: parsed.toolCalls.map((call) => ({ name: call.name, args: summarizeArgs(call.args) })),
        tool_results: parsed.toolResults,
        progress_notes: parsed.progressNotes,
        answer_part_lengths: parsed.answerPartLengths,
        unknown_records: parsed.unknown.length,
      };

      // A timeout means the answer is truncated even when text was produced — never report
      // a killed call as a clean result. (This is the defect that made the file-backed job
      // layer report killed jobs as "done".)
      if (timedOut) {
        writeLog({ ...log, status: "timeout", partial_answer: parsed.answer || null, stderr: stderr.slice(0, 4000) });

        reject(
          new Error(
            `Kimi was killed by the ${timeoutSec}s timeout. ` +
              (parsed.answer
                ? `Partial output (${parsed.answer.length} chars) was produced` +
                  (LOGGING_ENABLED
                    ? " and kept in the log — treat it as incomplete."
                    : " and discarded; set KIMI_BRIDGE_LOG=1 to keep partial output.")
                : "No answer had been produced.") +
              ` Tool calls made: ${parsed.toolCalls.length}.`,
          ),
        );
        return;
      }

      if (!parsed.answer) {
        writeLog({
          ...log,
          status: "no_answer",
          stderr: stderr.slice(0, 4000),
          stdout: stdout.slice(0, 4000),
        });

        reject(
          new Error(
            `Kimi returned no answer (exit ${code}).\n` +
              `stdout: ${stdout.slice(0, 2000) || "(empty)"}\n` +
              `stderr: ${stderr.slice(0, 2000) || "(empty)"}`,
          ),
        );
        return;
      }

      writeLog({ ...log, status: "ok", answer: parsed.answer });

      // A parsed answer wins over a non-zero exit: see the libuv note at the top.
      resolve({ ...parsed, exitCode: code, durationMs: Date.now() - startedAt });
    });
  });
}

function formatResult(result) {
  const parts = [result.answer];
  const footer = [];

  if (result.toolCalls.length) {
    const listed = result.toolCalls
      .map((call) => {
        const args = summarizeArgs(call.args);

        return args ? `${call.name}(${args})` : call.name;
      })
      .join("\n  ");

    footer.push(`Kimi called ${result.toolCalls.length} tool(s):\n  ${listed}`);
  } else {
    footer.push("Kimi called NO tools — this answer is from the model's own knowledge, not verified against anything.");
  }

  footer.push(`Took ${(result.durationMs / 1000).toFixed(1)}s.`);

  if (result.sessionId) {
    footer.push(`session_id: ${result.sessionId} (pass it back as session_id to continue this thread)`);
  }

  if (result.unknown.length) {
    footer.push(`Unrecognized stream records: ${result.unknown.length} (possible kimi-code format change).`);
  }

  parts.push(`\n---\n${footer.join("\n")}`);

  return parts.join("\n");
}

const ASK_DESCRIPTION_DEFAULT =
  "Ask Kimi (Moonshot K3) — an independent coding agent running locally — a question, or delegate analysis to it. " +
  "Kimi reasons differently from Claude and has its own MCP toolset (1C metadata graphs for УТ/ERP, embeddings, " +
  "syntax checker, SSL search, ITS, v8std), so it can verify claims about 1C metadata instead of guessing. " +
  "Use it for a second opinion, an open question, or to cross-check a conclusion. For code review or critique " +
  "use kimi_review instead — it enforces a brief and an output contract that this tool does not. " +
  "The reply reports which tools Kimi actually called — treat an answer with no tool calls as unverified. ";

const ASK_DESCRIPTION_NEUTRAL =
  "Ask Kimi (Moonshot K3) — an independent coding agent running locally — a question, or delegate analysis to it. " +
  "This is the ISOLATED profile: Kimi has NO MCP servers here. It answers from its own knowledge, from files you " +
  "point it at, and from its built-in web search — it CANNOT look anything up in a metadata graph, a code index or " +
  "a documentation search, so nothing it says about 1C configurations is verified. Use it for work outside 1C: " +
  "research, reasoning, code in other stacks, or a second opinion where an independently-reasoning model is the " +
  "point rather than a lookup. For anything that has to be checked against 1C metadata, use the kimi-bridge server " +
  "instead — this profile has no way to do it and will answer confidently anyway. " +
  "The reply reports which tools Kimi actually called; here those can only be its own Read/Write/Bash and web " +
  "search, never an external index. ";

const ASK_DESCRIPTION_COMMON =
  "A call takes 15-60s and is moved to a background task automatically if it runs past two minutes, so it will " +
  "not block you — but it still costs a turn, so do NOT delegate what one or two of your own tool calls would " +
  "answer, and batch related questions about the same object into ONE call. To run several in parallel, issue " +
  "several tool calls in a single message. " +
  "Pass session_id from a previous answer to continue the same thread — appropriate for iterating on one " +
  "artifact, but never for a second opinion, where a carried-over context inherits the first answer's assumptions.";

const server = new McpServer({
  name: IS_NEUTRAL_PROFILE ? "kimi-bridge-neutral" : "kimi-bridge",
  version: VERSION,
});

const filesSchema = z
  .array(z.string())
  .optional()
  .describe(
    "Paths for Kimi to open ITSELF (relative to cwd, or absolute). Use this instead of pasting large " +
      "modules inline — Kimi has a 1M context and its own Read tool, so a 70KB module costs the caller nothing.",
  );

server.registerTool(
  "kimi_ask",
  {
    description: (IS_NEUTRAL_PROFILE ? ASK_DESCRIPTION_NEUTRAL : ASK_DESCRIPTION_DEFAULT) + ASK_DESCRIPTION_COMMON,
    inputSchema: z.object({
      prompt: z
        .string()
        .min(1)
        .describe(
          "The question or task for Kimi. Be self-contained: include the code, the diff and the context, " +
            "since Kimi does not see this conversation.",
        ),
      files: filesSchema,
      cwd: z
        .string()
        .optional()
        .describe(
          "Working directory for Kimi. Defaults to the Claude Code working directory. " +
            "Set it explicitly when Kimi should read a different project's files.",
        ),
      session_id: z
        .string()
        .optional()
        .describe("session_id returned by a previous kimi_ask call — continues that conversation instead of a new one."),
      model: z
        .string()
        .optional()
        .describe(
          "Model alias override: kimi-code/k3 (default, 1M context), kimi-code/k3-256k, " +
            "kimi-code/kimi-for-coding (K2.7), kimi-code/kimi-for-coding-highspeed.",
        ),
      timeout_sec: z
        .number()
        .int()
        .min(30)
        .max(1800)
        .optional()
        .describe(`Hard timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SEC}. On timeout the call FAILS rather than returning a partial answer.`),
    }),
  },
  async ({ prompt, files, cwd, session_id, model, timeout_sec }) => {
    try {
      const result = await runKimi({
        prompt: buildAskPrompt({ prompt, files }),
        cwd,
        sessionId: session_id,
        model,
        timeoutSec: timeout_sec ?? DEFAULT_TIMEOUT_SEC,
      });

      return { content: [{ type: "text", text: formatResult(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: `kimi_ask failed: ${error.message}` }] };
    }
  },
);

// kimi_review is 1C-specific by construction: buildReviewPrompt casts Kimi as a BSL reviewer,
// demands a target configuration, and requires every metadata claim to be checked with a tool.
// On the neutral profile there are no such tools, so the contract would still ask for a
// "Подтверждено инструментами" section and Kimi would fill it from memory. Not registering the
// tool is the honest option: a caller cannot reach for what is not there.
if (!IS_NEUTRAL_PROFILE) {
  server.registerTool(
    "kimi_review",
    {
      description:
        "Have Kimi review 1C (BSL) code as an independent reviewer, and get findings back in a fixed contract: " +
        "verdict, findings with severity and evidence, what was verified with tools, and what could NOT be verified. " +
        "Prefer this over kimi_ask for any review or critique — the brief and the output contract are built here, " +
        "so the target configuration and the verification requirement cannot be forgotten. " +
        "Pass whole modules via `files` (Kimi reads them itself), not inline. " +
        "Deliberately starts a FRESH session every time: a reviewer carrying the author's context inherits the " +
        "author's assumptions, and cross-context review measurably outperforms same-context review. " +
        "A full module review takes ~10 minutes; the call is backgrounded automatically after two minutes and you " +
        "get a notification when it settles. To review several modules at once, issue several calls in one message. " +
        "WARNING — the bridge does NOT sandbox Kimi. The \"do not edit anything\" rule lives only in the prompt: " +
        "Kimi runs in `cwd` with its own Write and Bash tools and whatever permission mode its config grants " +
        "(auto by default), so it CAN modify files. Set `cwd` deliberately and keep it under version control. " +
        "Applying fixes is still the caller's job.",
      inputSchema: z.object({
        subject: z
          .string()
          .optional()
          .describe(
            "Code or diff to review, inline. For whole modules prefer `files` — this is for diffs and short fragments. " +
              "Can also carry context about the change. Either subject or files is required.",
          ),
        files: filesSchema,
        target: z
          .string()
          .min(1)
          .describe(
            "REQUIRED. Target environment in plain words: configuration, version, base vs extension. " +
              'For example: "ERP 2.5.22, доработка в расширении" or "УТ 11.5, основная конфигурация". ' +
              "Naming the wrong base yields a coherent and entirely wrong review, so there is no default.",
          ),
        focus: z
          .string()
          .optional()
          .describe(
            "What to prioritize: performance, transactions and locks, ITS standards, a specific suspicion. " +
              "State it neutrally — naming a suspected culprit invites confirmation instead of verification.",
          ),
        known_good: z
          .string()
          .optional()
          .describe(
            "What is ALREADY proven to work in practice — 'the form ran on document X', 'the query was tested', " +
              "'syntaxcheck passed'. Measured effect: without it Kimi spent 14 tool calls and returned a 'concern'; " +
              "with it, 5 calls on the same module and a genuine blocker. Fill this in whenever you can.",
          ),
        cwd: z
          .string()
          .optional()
          .describe(
            "Working directory, so Kimi can open the files listed above. Defaults to the Claude Code directory. " +
              "Kimi gets WRITE access here — choose it deliberately.",
          ),
        budget_tool_calls: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe(
            "Ceiling on Kimi's tool calls, written into the brief. A guideline, not a hard stop — Kimi may overshoot " +
              "slightly (12 given, 14 used in one run). Defaults to 7.",
          ),
        model: z.string().optional().describe("Model alias override. Omit to use the configured default."),
        timeout_sec: z
          .number()
          .int()
          .min(30)
          .max(1800)
          .optional()
          .describe(
            `Hard timeout in seconds. Defaults to ${DEFAULT_REVIEW_TIMEOUT_SEC}. A full module review runs 10+ minutes. ` +
              "On timeout the call FAILS rather than returning a partial review.",
          ),
      }),
    },
    async (input) => {
      try {
        if (!input.subject && !input.files?.length) {
          throw new Error("Provide `subject` (inline code) or `files` (paths for Kimi to read), or both.");
        }

        const result = await runKimi({
          prompt: buildReviewPrompt({
            subject: input.subject,
            target: input.target,
            focus: input.focus,
            files: input.files,
            known: input.known_good,
            budgetToolCalls: input.budget_tool_calls ?? 7,
          }),
          cwd: input.cwd,
          sessionId: undefined, // no resume by design — see the freshness rationale above
          model: input.model,
          timeoutSec: input.timeout_sec ?? DEFAULT_REVIEW_TIMEOUT_SEC,
        });

        return { content: [{ type: "text", text: formatResult(result) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: `kimi_review failed: ${error.message}` }] };
      }
    },
  );
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `kimi-bridge ${VERSION} on stdio, profile: ${IS_NEUTRAL_PROFILE ? "neutral (no MCP, kimi_ask only)" : "default"} ` +
      `(logs: ${LOGGING_ENABLED ? LOG_DIR : "disabled"})`,
  );
}

// Only start the server when run directly, so tests can import parseStreamJson
// without a stdio server hanging around.
// Compare real paths, not URLs. When this file is reached through a symlink or junction, Node
// resolves import.meta.url to the link TARGET while argv[1] keeps the path as spawned. A plain URL
// comparison is then false and the server exits 0 without ever starting — a silent no-op, not an
// error. Paths are compared case-insensitively on Windows, where realpathSync keeps the case it
// was handed and the same file can arrive as c:\... or C:\...
function startedDirectly() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    const entry = realpathSync(process.argv[1]);
    const self = realpathSync(fileURLToPath(import.meta.url));

    // Windows paths are case-insensitive while realpathSync preserves the case it was handed,
    // so the same file reached as c:\... and C:\... compares unequal on a strict ===.
    if (process.platform === "win32") {
      return entry.toLowerCase() === self.toLowerCase();
    }

    return entry === self;
  } catch (error) {
    // Never fail silently: an unresolvable path would exit 0 with no output, which is the exact
    // failure mode this predicate was rewritten to remove.
    console.error(`kimi-bridge: cannot resolve entry path, not starting — ${error.message}`);

    return false;
  }
}

if (startedDirectly()) {
  main().catch((error) => {
    console.error("Fatal error in kimi-bridge:", error);
    process.exit(1);
  });
}

export { resolveKimiEntry, formatResult, runKimi };
