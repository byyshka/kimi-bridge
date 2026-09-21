# kimi-bridge

An MCP server that makes a locally installed **Kimi Code CLI** available inside Claude Code as a
second agent.

**This bridge is aimed at 1C:Enterprise development**, and it is worth being precise about where
that shows. The machinery — spawning the CLI, parsing its stream, sessions, timeouts, the summary of
tools actually called — is general. The 1C part is one tool: `kimi_review` casts Kimi as a BSL
reviewer and tells it to verify metadata through its graph servers.

That tool is registered **only in the default profile**. The `neutral` profile exposes `kimi_ask`
alone, so nothing 1C-flavoured reaches a general-purpose setup. If you do not work with 1C you get a
solid second-agent bridge without a review tool; if you do, you get a reviewer that checks
attributes against real metadata instead of recalling them.

## Set up the Kimi CLI first

This bridge is a thin adapter: it spawns the Kimi CLI and parses its output. It installs nothing and
authenticates nothing.

1. **Install the CLI — through npm, and pinned.**

   ```powershell
   npm i -g @moonshot-ai/kimi-code@0.31.1
   kimi login
   ```

   Two things are deliberate here.

   **The version is pinned** because that is the one this bridge's stream parsing was written
   against and tested on. `@latest` currently resolves to the `2.x` line, which is untested here —
   see the version note above before reaching for it.

   **Install through npm, not the one-line installer.** Moonshot also publishes
   `irm https://code.kimi.com/kimi-code/install.ps1 | iex`, which drops a `kimi` binary on `PATH`.
   This bridge does not use that binary: it spawns `dist/main.mjs` through `node` directly, because
   the `kimi` shim is a `.cmd` wrapper and would force `shell: true`, breaking argv escaping for
   prompts with quotes or non-ASCII text. If you already installed that way, point
   `KIMI_BRIDGE_ENTRY` at a `dist/main.mjs` you do have — otherwise the bridge will list the paths
   it tried and stop.

   Login is a device-code OAuth flow against a Kimi subscription; an API key works too. Confirm the
   CLI works on its own before wiring up the bridge:

   ```powershell
   kimi -p "reply with one word: ok" --output-format stream-json
   ```

2. **Give Kimi its own MCP servers — this is the part that takes real time, and the part that
   makes the bridge worth having.** Kimi reads its own `mcp.json` (on Windows,
   `%USERPROFILE%\.kimi-code\mcp.json`; `$KIMI_CODE_HOME` moves it), entirely separate from your
   Claude configuration. Nothing here configures those servers and nothing is inherited from
   Claude's set — consult Kimi's own documentation for the file's schema.

   The file is a map of server names to launch configs:

   ```json
   {
     "mcpServers": {
       "some-stdio-server": {
         "type": "stdio",
         "command": "npx",
         "args": ["-y", "some-mcp-package"],
         "env": { "SOME_TOKEN": "..." }
       },
       "some-http-server": {
         "type": "http",
         "url": "http://localhost:8080/mcp"
       }
     }
   }
   ```

   Without them you get a second opinion from memory. With them you get an agent that checks a
   claim before answering — and the footer on every reply tells you which of the two you got.

3. **Know which instruction files Kimi actually reads.** Measured, not assumed: Kimi picks up
   **`AGENTS.md`** and the skill list under `.agents/skills/`. It does **not** read `CLAUDE.md`,
   `RULES.md` or anything in `.claude/rules/`. Any convention you expect the delegated agent to
   honour has to live in `AGENTS.md` — a rule kept only in `CLAUDE.md` never reaches it, silently.

## Why a second agent at all

Kimi runs with **its own MCP servers**, configured in its own home directory, independent of
Claude's. In the setup this was built for those are 1C metadata graphs, code embeddings, a syntax
checker and standards lookups. That makes the difference between "a second model that agrees with
you" and a reviewer that can check whether an attribute actually exists before answering.

Kimi also has a 1M-token context and opens files itself, so a 70 KB module passed by path costs the
caller nothing.

## Requirements

- **Node.js ≥ 20.11** for this bridge — but see the version note below, the CLI wants more
- **Kimi Code CLI**, installed so that its `dist/main.mjs` exists on disk:
  `npm i -g @moonshot-ai/kimi-code`, then `kimi login`
- Optionally, MCP servers configured in Kimi's own `mcp.json` — that is where the value comes from

**Windows only.** Built and tested on Windows 11. There are POSIX branches in the code, but they are
neither tested nor supported.

### Version note — read this before installing

**Verified against kimi-code `0.31.1`.** The stream parsing here is written to that version's
NDJSON records. The published CLI has since moved to the `2.x` line, and this bridge has **not**
been tested against it; if the record shapes changed, the bridge will return "no answer" while the
CLI itself works fine. Pin the CLI or expect to adjust `parseStreamJson`.

**The CLI needs Node ≥ 22.19**, even though the bridge itself runs on 20.11. Installing it under
Node 20 fails on the `engines` check. If you are on 20.x, the bridge will run but you will have no
CLI to drive.

**Install it through npm, pinned to that version** — the setup section below gives the command and
explains why the one-line Windows installer is the wrong route here.

## Install

```powershell
git clone https://github.com/byyshka/kimi-bridge.git
cd kimi-bridge
npm install
npm test          # optional: runs offline, needs neither the Kimi CLI nor a login

claude mcp add kimi-bridge --scope user -- node C:\path\to\kimi-bridge\index.mjs
```

Restart the client afterwards. The `claude` CLI has to be installed already.

## Tools

### `kimi_ask(prompt, files?, cwd?, session_id?, model?, timeout_sec?)`

An open question or a delegated analysis. Pass **files** as paths for Kimi to open itself rather
than pasting their contents.

`session_id` continues a previous thread — right for iterating on one artifact, wrong for a second
opinion, where carrying context over means inheriting the first answer's assumptions.

### `kimi_review(subject, target, focus?, files?, known_good?, budget_tool_calls?, cwd?, model?, timeout_sec?)`

A review with a fixed output contract: verdict, findings, *confirmed by tools*, *could not check*.
The last section is mandatory — "nothing" is an answer, silence is not.

It takes **no `session_id` on purpose**: a review always starts a fresh session, because a reviewer
holding the author's context inherits the author's blind spots.

## Every answer says what it was based on

Each reply ends with the tools Kimi actually called. When there were none, it says so outright:

```text
Kimi called NO tools — this answer is from the model's own knowledge, not verified against anything.
```

That line is the whole point. Without it, an answer recalled from training data is indistinguishable
from one checked against your metadata.

## Two profiles from one binary

Register the same file twice under different names to have both: a tooled agent for questions about
your codebase, and an isolated one for everything else, where an answer from the model's own
knowledge is the honest form.

**Two variables, and both are needed.** `KIMI_BRIDGE_PROFILE=neutral` changes only what this server
advertises — its name, its tool descriptions, and the fact that `kimi_review` is not registered.
Which MCP servers Kimi actually has is decided by `KIMI_CODE_HOME`, which the child process
inherits. Setting the profile alone gives you a tooled Kimi wearing a description that says it has
no tools, which is worse than either honest state.

```json
{
  "mcpServers": {
    "kimi-bridge": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\kimi-bridge\\index.mjs"]
    },
    "kimi-clean": {
      "type": "stdio",
      "command": "node",
      "args": ["C:\\path\\to\\kimi-bridge\\index.mjs"],
      "env": {
        "KIMI_BRIDGE_PROFILE": "neutral",
        "KIMI_CODE_HOME": "C:\\path\\to\\a\\kimi-home-with-empty-mcp-json",
        "KIMI_BRIDGE_LOG_DIR": "C:\\path\\to\\kimi-bridge\\logs-clean"
      }
    }
  }
}
```

The two register **different tool descriptions on purpose**. A description promising metadata
verification, sitting in front of a profile with no tools, is exactly how an unverified answer gets
read as a checked one.

## What it looks like in use

Pass files by path — Kimi opens them itself, so their text never enters the calling agent's context:

```js
kimi_ask({
  prompt: "Does ПолучитьЦенуНоменклатуры handle an empty price type? Answer yes or no with " +
          "the line number, and say so plainly if you could not check.",
  files: ["src/CommonModules/Ценообразование/Module.bsl"]
})
```

```text
Нет. Строка 47: при пустом виде цены запрос вернёт пустую выборку, и функция вернёт 0
вместо ошибки — вызывающий код не отличит «цена нулевая» от «цена не найдена».

---
Kimi called 2 tool(s):
  Read(path=src/CommonModules/Ценообразование/Module.bsl)
  search_metadata(operation=list_attributes, object=Справочник.ВидыЦен)
Took 24.1s.
session_id: session_0bd086c7 (pass it back as session_id to continue this thread)
```

The footer is the part to read first. Two tool calls means the answer was checked against something;
`Kimi called NO tools` means it was not.

## When it does not work

**`Kimi Code CLI entrypoint not found`**
The error lists every path that was tried. Under nvm, fnm or volta the global root moves with the
active Node version — if none of the listed paths is right, set `KIMI_BRIDGE_ENTRY` to your
`dist/main.mjs` directly.

**Kimi answers, but the reply ends with `Kimi called NO tools`**
The answer came from the model's own knowledge. For a question of fact about your codebase that is
not a verified answer — name the files in `files`, or check whether Kimi's own `mcp.json` actually
has the servers you expect.

**The server starts and nothing happens: exit 0, no output, no error**
The entry-point check. Reached through a symlink or junction, Node resolves `import.meta.url` to the
link target while `argv[1]` keeps the path as spawned, so a naive comparison concludes the file was
imported rather than run and never calls `main()`. This bridge compares resolved real paths
(case-insensitively on Windows) for exactly that reason.

**A run ends with a libuv assertion on Windows**
Expected, and handled: kimi-code trips it while tearing down handles, after the answer is already on
stdout. The bridge trusts the parsed answer over the exit code.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIMI_BRIDGE_ENTRY` | auto-detected | Absolute path to `dist/main.mjs`. Wins over detection. |
| `KIMI_BRIDGE_PROFILE` | `default` | `neutral` registers `kimi_ask` only. |
| `KIMI_CODE_HOME` | Kimi's default | Which Kimi home (and thus which MCP set) to use. |
| `KIMI_BRIDGE_LOG` | off | Set to `1` to enable the call log. |
| `KIMI_BRIDGE_LOG_DIR` | `logs/` next to `index.mjs` | Where the log is written. Not relative to the working directory. |

If the CLI cannot be found, the error lists every path that was tried.

## Logging is off by default

With `KIMI_BRIDGE_LOG=1` every call is appended to `logs/YYYY-MM-DD.jsonl` — prompt, answer, tools
called, timings. Useful for working out why Kimi got something wrong, and nobody's business by
default, so it stays off until you ask.

## Behaviour worth knowing

- **Exit codes are not trusted.** kimi-code trips a libuv assertion on Windows while tearing down
  handles, *after* the answer is already on stdout. A parsed answer therefore wins over exit status.
- **The CLI is spawned as `node dist/main.mjs`**, not through the `kimi` shim. The shim is a
  `.cmd`/`.ps1` wrapper, which would force `shell: true` and break argv escaping for prompts holding
  quotes, newlines or non-ASCII text.
- **A timeout fails the call.** A truncated answer is never returned as though it were complete.
- **Kimi narrates while it works**, and each narration line is an assistant record shaped exactly
  like the real answer. The bridge takes the text after the last tool call as the answer.
- **No background job layer**, deliberately. An earlier version grew one; the premise was false,
  since killing the bridge kills the child anyway. Claude Code already backgrounds any call running
  past two minutes.
- **No sandbox.** Kimi runs with permission to write in its working directory. Pass `cwd`
  deliberately.

## License

MIT
