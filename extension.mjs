// Extension: fork-session
// Slash command and tool to fork a Copilot CLI session into a new resumable session.
//
// Usage:
//   /fork                              Fork the current session
//   /fork <uuid>                       Fork a session by UUID
//   /fork "search terms"               Fork a session by partial summary match
//   /fork [...] --name="My new name"   Override the new session summary

import { DatabaseSync } from "node:sqlite";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { joinSession } from "@github/copilot-sdk/extension";

const COPILOT_HOME = process.env.COPILOT_HOME || join(homedir(), ".copilot");
const DB_PATH = join(COPILOT_HOME, "session-store.db");
const STATE_DIR = join(COPILOT_HOME, "session-state");
const FORK_PREFIX = "Forked:";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function openDb() {
    if (!existsSync(DB_PATH)) {
        throw new Error(`Session store not found at ${DB_PATH}`);
    }
    const db = new DatabaseSync(DB_PATH);
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec("PRAGMA foreign_keys = ON;");
    return db;
}

function parseArgs(raw) {
    const text = (raw || "").trim();
    let newName;
    let rest = text;

    const namePatterns = [
        /--name=(?:"([^"]*)"|'([^']*)'|(\S+))/,
        /--name\s+(?:"([^"]*)"|'([^']*)'|(\S+))/,
    ];
    for (const re of namePatterns) {
        const match = rest.match(re);
        if (match) {
            newName = match[1] ?? match[2] ?? match[3];
            rest = (rest.slice(0, match.index) + rest.slice(match.index + match[0].length)).trim();
            break;
        }
    }

    let source = rest;
    const quoted = source.match(/^"([^"]*)"$|^'([^']*)'$/);
    if (quoted) {
        source = quoted[1] ?? quoted[2];
    }
    source = source.trim();

    return { source, newName };
}

function resolveSourceSession(db, sourceArg, currentSessionId) {
    if (!sourceArg) {
        const row = db.prepare("SELECT id, summary FROM sessions WHERE id = ?").get(currentSessionId);
        if (!row) {
            throw new Error(`Current session ${currentSessionId} not found in store yet — try again after a turn completes.`);
        }
        return { ...row, isCurrent: true };
    }

    if (UUID_RE.test(sourceArg)) {
        const row = db.prepare("SELECT id, summary FROM sessions WHERE id = ?").get(sourceArg);
        if (!row) throw new Error(`No session with id ${sourceArg}.`);
        return { ...row, isCurrent: row.id === currentSessionId };
    }

    const like = `%${sourceArg}%`;
    const matches = db
        .prepare(
            "SELECT id, summary, updated_at FROM sessions WHERE summary LIKE ? ORDER BY updated_at DESC LIMIT 10",
        )
        .all(like);

    if (matches.length === 0) {
        throw new Error(`No session matching "${sourceArg}". Use /fork <uuid> or part of the summary.`);
    }
    if (matches.length > 1) {
        const list = matches
            .map((m) => `  • ${m.id}  ${m.summary || "(no summary)"}`)
            .join("\n");
        throw new Error(
            `Multiple sessions match "${sourceArg}". Re-run with the exact UUID:\n${list}`,
        );
    }
    const row = matches[0];
    return { ...row, isCurrent: row.id === currentSessionId };
}

function cloneRows(db, srcId, newId) {
    const ops = [
        // turns: AUTOINCREMENT id, copy everything else
        `INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp)
         SELECT ?, turn_index, user_message, assistant_response, timestamp
         FROM turns WHERE session_id = ?`,
        `INSERT INTO checkpoints (session_id, checkpoint_number, title, overview, history, work_done, technical_details, important_files, next_steps, created_at)
         SELECT ?, checkpoint_number, title, overview, history, work_done, technical_details, important_files, next_steps, created_at
         FROM checkpoints WHERE session_id = ?`,
        `INSERT INTO session_files (session_id, file_path, tool_name, turn_index, first_seen_at)
         SELECT ?, file_path, tool_name, turn_index, first_seen_at
         FROM session_files WHERE session_id = ?`,
        `INSERT INTO session_refs (session_id, ref_type, ref_value, turn_index, created_at)
         SELECT ?, ref_type, ref_value, turn_index, created_at
         FROM session_refs WHERE session_id = ?`,
    ];
    const counts = {};
    for (const sql of ops) {
        const result = db.prepare(sql).run(newId, srcId);
        const table = sql.match(/INSERT INTO (\w+)/)[1];
        counts[table] = result.changes;
    }

    // FTS5 search_index — best-effort, skip if it fails (rebuildable from turns)
    try {
        const fts = db
            .prepare(
                "INSERT INTO search_index (content, session_id, source_type, source_id) " +
                "SELECT content, ?, source_type, source_id FROM search_index WHERE session_id = ?",
            )
            .run(newId, srcId);
        counts.search_index = fts.changes;
    } catch (err) {
        counts.search_index = `skipped (${err.message})`;
    }
    return counts;
}

async function copyStateDir(srcId, newId, newSummary, userNamed) {
    const srcDir = join(STATE_DIR, srcId);
    const dstDir = join(STATE_DIR, newId);
    if (!existsSync(srcDir)) {
        return { copied: false, reason: `source state dir missing: ${srcDir}` };
    }
    await mkdir(dirname(dstDir), { recursive: true });
    await cp(srcDir, dstDir, { recursive: true, force: false, errorOnExist: true });
    // Strip IDE/window-bound metadata so the fork doesn't latch onto the source's editor session
    for (const f of ["vscode.metadata.json"]) {
        const p = join(dstDir, f);
        try {
            await rm(p, { force: true });
        } catch {}
    }
    // Rewrite workspace.yaml so the fork has its OWN identity. Copilot CLI's
    // /resume picker reads name/summary from this file (not from the central
    // session-store.db's `summary` column), and a wrong `id` here would cause
    // sync collisions with the source session on remote-steered installs.
    const wsPath = join(dstDir, "workspace.yaml");
    if (existsSync(wsPath)) {
        try {
            const original = await readFile(wsPath, "utf8");
            const nowIso = new Date().toISOString();
            const replacements = [
                [/^id:\s.*$/m, `id: ${newId}`],
                [/^name:\s.*$/m, `name: ${newSummary}`],
                [/^summary:\s.*$/m, `summary: ${newSummary}`],
                [/^user_named:\s.*$/m, `user_named: ${userNamed ? "true" : "false"}`],
                [/^created_at:\s.*$/m, `created_at: ${nowIso}`],
                [/^updated_at:\s.*$/m, `updated_at: ${nowIso}`],
                // Wipe remote-control / multiplayer ids so the fork doesn't try
                // to attach to the source's remote session.
                [/^mc_task_id:\s.*$/m, `mc_task_id: ""`],
                [/^mc_session_id:\s.*$/m, `mc_session_id: ""`],
                [/^mc_last_event_id:\s.*$/m, `mc_last_event_id: ""`],
            ];
            let updated = original;
            for (const [re, repl] of replacements) {
                if (re.test(updated)) updated = updated.replace(re, repl);
            }
            await writeFile(wsPath, updated, "utf8");
        } catch (err) {
            return { copied: true, path: dstDir, workspaceRewriteError: err.message };
        }
    }
    // Rewrite events.jsonl: the session.start event embeds the source's
    // sessionId, and Copilot CLI compares it against the directory name when
    // computing the displayed summary in /resume. A mismatch makes Copilot
    // treat the session as "recovered" and regenerate the display name from
    // the first user message instead of using workspace.yaml's summary.
    // Rewriting every literal occurrence of the source UUID is the simplest
    // safe transform — UUIDs are 36-char tokens with no false-positive risk.
    const eventsPath = join(dstDir, "events.jsonl");
    if (existsSync(eventsPath)) {
        try {
            const original = await readFile(eventsPath, "utf8");
            const updated = original.split(srcId).join(newId);
            if (updated !== original) {
                await writeFile(eventsPath, updated, "utf8");
            }
        } catch (err) {
            return { copied: true, path: dstDir, eventsRewriteError: err.message };
        }
    }
    const st = await stat(dstDir);
    return { copied: true, path: dstDir, sizeBytes: st.size };
}

async function performFork(db, source, newName) {
    const newId = randomUUID();
    const baseSummary = source.summary || `Session ${source.id.slice(0, 8)}`;
    const finalSummary = newName?.trim() || `${FORK_PREFIX} ${baseSummary}`;

    db.exec("BEGIN IMMEDIATE");
    let counts;
    try {
        const sessionRow = db
            .prepare(
                "SELECT cwd, repository, branch, host_type FROM sessions WHERE id = ?",
            )
            .get(source.id);
        if (!sessionRow) throw new Error(`Source session ${source.id} disappeared mid-fork.`);

        db.prepare(
            `INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
             VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'), ?)`,
        ).run(newId, sessionRow.cwd, sessionRow.repository, sessionRow.branch, finalSummary, sessionRow.host_type);

        counts = cloneRows(db, source.id, newId);
        db.exec("COMMIT");
    } catch (err) {
        db.exec("ROLLBACK");
        throw err;
    }

    const stateResult = await copyStateDir(source.id, newId, finalSummary, Boolean(newName?.trim()));
    return { newId, finalSummary, counts, stateResult };
}

function formatReport(source, result) {
    const c = result.counts;
    const lines = [
        `✅ Forked session ${source.id} → ${result.newId}`,
        `   Summary: "${result.finalSummary}"`,
        `   Rows cloned: turns=${c.turns}, checkpoints=${c.checkpoints}, files=${c.session_files}, refs=${c.session_refs}, fts=${c.search_index}`,
    ];
    if (result.stateResult.copied) {
        lines.push(`   State dir: ${result.stateResult.path}`);
    } else {
        lines.push(`   ⚠️  State dir NOT copied (${result.stateResult.reason}). The fork has DB rows but no events.jsonl — /resume may behave oddly.`);
    }
    if (source.isCurrent) {
        lines.push(`   ℹ️  Snapshot of the CURRENT session captured up to the previous turn (this /fork turn itself is not in the fork).`);
    }
    lines.push("");
    lines.push(`   👉 Resume the fork in another terminal:`);
    lines.push(`      copilot --resume="${result.newId}"`);
    return lines.join("\n");
}

async function runFork(rawArgs, currentSessionId) {
    const { source: sourceArg, newName } = parseArgs(rawArgs);
    const db = openDb();
    try {
        const source = resolveSourceSession(db, sourceArg, currentSessionId);
        const result = await performFork(db, source, newName);
        return { ok: true, message: formatReport(source, result), result };
    } finally {
        db.close();
    }
}

const slashHandler = async (context) => {
    try {
        const { message } = await runFork(context.args, context.sessionId);
        await session.log(message);
    } catch (err) {
        await session.log(`Fork failed: ${err.message}`, { level: "error" });
    }
};

const session = await joinSession({
    commands: [
        {
            name: "fork",
            description: "Fork a Copilot session (current by default) into a new resumable session.",
            handler: slashHandler,
        },
    ],
    tools: [
        {
            name: "fork_session",
            description:
                "Fork a Copilot CLI session into a new resumable one. Without 'source', forks the current session. " +
                "'source' may be a UUID or a substring of the session summary. Optional 'newName' overrides the fork summary.",
            parameters: {
                type: "object",
                properties: {
                    source: {
                        type: "string",
                        description: "Session UUID or partial summary text. Omit to fork the current session.",
                    },
                    newName: {
                        type: "string",
                        description: "Optional new summary for the forked session. Defaults to '<original> [fork]'.",
                    },
                },
            },
            handler: async (args, invocation) => {
                try {
                    const argString = [args?.source ? JSON.stringify(args.source) : "", args?.newName ? `--name=${JSON.stringify(args.newName)}` : ""]
                        .filter(Boolean)
                        .join(" ");
                    const { message, result } = await runFork(argString, invocation.sessionId);
                    return {
                        resultType: "success",
                        textResultForLlm: message,
                        sessionLog: `Forked → ${result.newId}`,
                    };
                } catch (err) {
                    return {
                        resultType: "failure",
                        textResultForLlm: `Fork failed: ${err.message}`,
                    };
                }
            },
        },
    ],
});
