# copilot-cli-fork-extension

A [GitHub Copilot CLI](https://github.com/github/copilot-cli) extension that adds a `/fork` slash command to **fork any session into a new resumable one** — like `git branch`, but for Copilot conversations.

```
/fork                                   # snapshot the current session
/fork "Diagnose Paper Trading"          # fork a past session by partial name
/fork 91e9e2f7-bc54-4e33-9296-...       # fork by UUID
/fork ... --name="Debug branch v2"      # set a custom name for the fork
```

Then resume the fork in another terminal:

```bash
copilot --resume="<new-uuid>"
# or by name (exact match)
copilot --resume="Forked: Diagnose Paper Trading"
```

The agent can also call the equivalent `fork_session` tool when you ask in natural language ("fork this session and call it X").

## Why?

Copilot CLI ships with `/resume` (switch sessions) but no native fork. If you want to **branch a conversation** — try a different approach without losing your current state, or hand off a snapshot to another terminal — this extension gives you that.

## How it works

A fork is a true snapshot. To produce a fork that `/resume` displays correctly and that doesn't collide with the source, the extension needs to do more than just copy bytes — five distinct things must be patched per fork:

1. **DB rows** (in `~/.copilot/session-store.db`): clones the row in `sessions` plus all related rows in `turns`, `checkpoints`, `session_files`, `session_refs`, and the `search_index` FTS5 table, all under a freshly generated UUID.
2. **State dir** (`~/.copilot/session-state/<src>/`): recursively copied to `<new-uuid>/` (events.jsonl, checkpoints/, files/, research/, rewind-snapshots/, session.db, workspace.yaml).
3. **`workspace.yaml` rewrite**: the fork gets its own `id`, `name`, `summary`, fresh timestamps, `user_named` flag, and **all `mc_*` remote-control fields are blanked** so the fork doesn't try to re-attach to the source's cloud session.
4. **YAML quoting of `name`/`summary`**: titles like `Forked: <src>` contain a colon, which would break unquoted YAML and cause `/resume` to fall back to deriving the display name from `events.jsonl`'s first user message — so the values are always written as double-quoted strings.
5. **`events.jsonl` rewrite**: every literal occurrence of the source UUID (notably in `session.start.data.sessionId`) is replaced with the new UUID. Without this, Copilot CLI sees a directory whose name doesn't match the embedded session id and treats the session as "recovered".

DB writes are wrapped in `BEGIN IMMEDIATE` with a `busy_timeout=5000` ms so the extension plays nicely with the live Copilot CLI process holding the same WAL DB open.

The fork's default summary is `Forked: <original summary>`. Override at creation with `--name="..."`. To rename later, `/resume` into the fork and use Copilot CLI's built-in `/rename`.

> **Note on the current session:** when you fork the active session, the snapshot captures everything **up to the previous turn** — the `/fork` invocation itself is not in the fork, since it hasn't been persisted yet. This is mentioned in the result message.

## Install

### As a user-scoped extension (recommended — works in every repo)

```bash
mkdir -p ~/.copilot/extensions/fork-session
curl -fsSL https://raw.githubusercontent.com/ghsioux/copilot-cli-fork-extension/main/extension.mjs \
  -o ~/.copilot/extensions/fork-session/extension.mjs
```

Then in your Copilot CLI session, run `/restart` (or just relaunch). Alternatively, in an interactive session you can ask the agent to call `extensions_reload` if your build exposes it.

### As a project-scoped extension

```bash
mkdir -p .github/extensions/fork-session
curl -fsSL https://raw.githubusercontent.com/ghsioux/copilot-cli-fork-extension/main/extension.mjs \
  -o .github/extensions/fork-session/extension.mjs
```

Project extensions shadow user extensions on name collision.

## Requirements

- **Copilot CLI** v1.0.40 or newer (the `commands:` field in `joinSession()` is required for slash commands).
- **Node.js 22+** (uses the built-in `node:sqlite` module — no npm dependencies).
- **macOS / Linux / Windows** all supported.

## Files touched

| Path | What |
|---|---|
| `~/.copilot/session-store.db` | INSERT into `sessions`, `turns`, `checkpoints`, `session_files`, `session_refs`, `search_index` (no DELETE, no UPDATE on existing rows) |
| `~/.copilot/session-state/<new-uuid>/` | Created by recursive copy from the source state dir, then `workspace.yaml` and `events.jsonl` are patched in place to carry the fork's own identity |

The source session is **never modified** — fork is a pure copy.

## Gotchas the extension already handles for you

These are mostly notes for forks of this extension or future Copilot CLI versions, but they explain why the code is more than a `cp -r` + `INSERT INTO sessions`:

- **The `/resume` picker reads `workspace.yaml`, not `sessions.summary`.** If the YAML can't be parsed, the picker silently falls back to deriving the display name from the first `user.message` in `events.jsonl`. A title with an unquoted colon (e.g. `name: Forked: Foo`) is enough to trigger this — so the extension always quotes `name` and `summary`.
- **`session.start` events embed the session id.** When the embedded id doesn't match the directory name, Copilot CLI treats the session as "recovered" and ignores the configured display name. That's why every literal occurrence of the source UUID in `events.jsonl` is rewritten to the new UUID.
- **`mc_task_id` / `mc_session_id` / `mc_last_event_id`** in `workspace.yaml` link a session to a remote multiplayer/coding-agent task. If they're left as the source's values in the fork, the fork tries to attach to the source's remote session on resume. The extension blanks them.
- **`vscode.metadata.json`** is intentionally not copied — Copilot CLI regenerates it with a fresh timestamp on first resume, and inheriting the source's value would make the IDE think the fork is the same window.

## Caveats

- The `session-store.db` schema and `workspace.yaml` shape are internal to Copilot CLI and not officially documented. **They may change in future Copilot versions** and break this extension. Tested against Copilot CLI **v1.0.40**.
- You cannot fork **into** the current process — the fork is created on disk and resumable by launching `copilot --resume="<uuid>"` in another terminal (or after `/exit`).
- If you fork while a turn is in flight, SQLite's busy timeout will block the fork up to 5 s waiting for the writer; if the timeout fires the fork is cleanly aborted (no partial state).

## Development

The extension is a single ES module file (`extension.mjs`, ~250 lines) using only Node.js built-ins. Edit it and run `extensions_reload` (or `/restart` Copilot CLI) to pick up changes — no build step.

To inspect what's loaded:

```
extensions_manage({ operation: "list" })
extensions_manage({ operation: "inspect", name: "fork-session" })
```

## License

MIT — see [LICENSE](LICENSE).

## Contributing

Issues and PRs welcome. Open ideas:
- Use a real YAML serializer (parse → mutate → re-emit) so `workspace.yaml` rewrites are robust to other special characters and future schema fields.
- Support for multi-version DB schemas (detect `schema_version` and refuse on incompatible).
- A `--turn-limit=N` flag to fork only the first N turns (branch before a bad turn).
- A `/sessions` listing helper that filters and prints the catalog as text instead of going through the TUI picker.
