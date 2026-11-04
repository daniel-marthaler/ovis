/**
 * Kimi Code keeps one append-only wire log per agent session:
 * `~/.kimi-code/sessions/wd_<dir>_<sha256(cwd)[:12]>/<session>/agents/<agent>/wire.jsonl`.
 * This file reads that log into conversation turns for the chat view.
 *
 * The pane's session is proven, never guessed: the log file a process of the pane's own
 * process tree holds open (Linux /proc), else the session id a live lock file names for
 * one of the pane's processes (`~/.kimi-code/locks/sessions/<id>.lock`, written by the
 * CLI itself, on every OS). With no such proof the chat falls back to the terminal —
 * no picking by creation time or newest mtime, on any OS.
 */
import { createHash } from "node:crypto";
import { opendirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";
import { trimOutput } from "./tool-output.ts";

/** The store directory Kimi Code derives from a working directory. */
export function kimiSessionsDir(cwd: string, home = homedir()): string {
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(home, ".kimi-code", "sessions", `wd_${basename(cwd)}_${key}`);
}

/** Every wire log path a pid holds open, resolved to its real path; empty on any read failure. */
function wireLogsHeld(pid: number): string[] {
  if (process.platform !== "linux") return [];
  let dir: ReturnType<typeof opendirSync>;
  try { dir = opendirSync(`/proc/${pid}/fd`); } catch { return []; }
  const held: string[] = [];
  try {
    let count = 0;
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++count > 4096) return [];
      let link: string;
      try { link = readlinkSync(`/proc/${pid}/fd/${entry.name}`); } catch { continue; }
      if (!link.includes("/.kimi-code/sessions/") || !link.endsWith("/wire.jsonl")) continue;
      try { held.push(realpathSync(link)); } catch { /* gone between readlink and realpath */ }
    }
  } finally { dir.closeSync(); }
  return held;
}

/** shell pid and every descendant of it, from /proc; the pane's agent process is one of them. */
function processTree(rootPid: number): number[] {
  const children = new Map<number, number[]>();
  let entries: string[];
  try { entries = readdirSync("/proc").filter((name) => /^\d+$/.test(name)); } catch { return [rootPid]; }
  for (const entry of entries) {
    let stat: string;
    try { stat = readFileSync(`/proc/${entry}/stat`, "utf8"); } catch { continue; }
    const fields = stat.split(") ").pop()!.split(" ");
    const ppid = Number(fields[1]);
    if (!Number.isSafeInteger(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), Number(entry)]);
  }
  const tree = [rootPid];
  for (let at = 0; at < tree.length && at < 64; at += 1) tree.push(...(children.get(tree[at]!) ?? []));
  return tree;
}

/** The session ids a pid owns, from the CLI's own lock files (written with a live heartbeat). */
export function kimiSessionIdsByPid(home = homedir()): Map<number, string> {
  const map = new Map<number, { sessionId: string; mtimeMs: number }>();
  let names: string[];
  try { names = readdirSync(join(home, ".kimi-code", "locks", "sessions")); } catch { return new Map(); }
  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    const path = join(home, ".kimi-code", "locks", "sessions", name);
    let lock: { pid?: unknown };
    try { lock = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }; } catch { continue; }
    const pid = lock.pid;
    if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1) continue;
    let mtimeMs: number;
    try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
    // a pid a stale lock shares with a live one says nothing: the newest lock wins
    const known = map.get(pid);
    if (known !== undefined && known.mtimeMs >= mtimeMs) continue;
    map.set(pid, { sessionId: name.slice(0, -".lock".length), mtimeMs });
  }
  return new Map([...map].map(([pid, entry]) => [pid, entry.sessionId]));
}

/** The main agent's wire log of the session with this id, via the index, else by scanning the stores. */
export function kimiWireForSessionId(sessionId: string, home = homedir()): string | null {
  try {
    const index = readFileSync(join(home, ".kimi-code", "session_index.jsonl"), "utf8");
    for (const line of index.split("\n")) {
      if (line.length === 0) continue;
      try {
        const entry = JSON.parse(line) as { sessionId?: unknown; sessionDir?: unknown };
        if (entry.sessionId === sessionId && typeof entry.sessionDir === "string" && entry.sessionDir.length > 0) {
          return join(entry.sessionDir, "agents", "main", "wire.jsonl");
        }
      } catch { /* skip a broken line */ }
    }
  } catch { /* no index */ }
  let stores: string[];
  try { stores = readdirSync(join(home, ".kimi-code", "sessions")); } catch { return null; }
  for (const store of stores) {
    if (!store.startsWith("wd_")) continue;
    const path = join(home, ".kimi-code", "sessions", store, sessionId, "agents", "main", "wire.jsonl");
    try { statSync(path); return path; } catch { /* not in this store */ }
  }
  return null;
}

/** The one wire log held open by the pane's process tree, or null when the evidence is not unique. */
export async function kimiPathFromProcessTree(paneId: string): Promise<string | null> {
  if (process.platform !== "linux") return null;
  const info = await paneProcessInfo(paneId).catch(() => null);
  const shell = info?.shell_pid;
  if (typeof shell !== "number" || !Number.isSafeInteger(shell) || shell <= 1) return null;
  const held = new Set<string>();
  for (const pid of processTree(shell)) for (const path of wireLogsHeld(pid)) held.add(path);
  return held.size === 1 ? [...held][0]! : null;
}

const paneResolution = new Map<string, { path: string | null; at: number; pinned: boolean }>();
const RESOLVE_TTL_MS = 15_000;
const PIN_VERIFY_MS = 30_000;

/**
 * The wire log for the pane, in order of evidence:
 *
 * 1. A file-descriptor match in the pane's process tree. The CLI appends and closes, so the log
 *    is open only in write bursts; the first match therefore pins the pane's session until a
 *    different match replaces it (a /clear in the pane).
 * 2. A session lock naming one of the pane's processes (its shell, foreground processes and,
 *    on Linux, the whole tree below the shell): the CLI writes one lock per live session with
 *    the owning pid, so this binds on every OS and separates two panes in one directory —
 *    each owns the session its own process holds.
 *
 * Without either proof the answer is null and the chat stays on the terminal; a session found
 * by any time (creation, mtime) would be another pane's or a finished one. Answers are cached
 * briefly; unpinned entries follow the TTL, a pin is re-verified on its own interval and kept
 * when no fresh fd evidence says otherwise.
 */
export async function kimiTranscriptPathForPane(pane: HerdrPane, home = homedir()): Promise<string | null> {
  const now = Date.now();
  const cached = paneResolution.get(pane.pane_id);
  if (cached !== undefined && (cached.pinned ? now - cached.at < PIN_VERIFY_MS : now - cached.at < RESOLVE_TTL_MS)) return cached.path;
  let path: string | null = null;
  let pinned = false;
  try { path = await kimiPathFromProcessTree(pane.pane_id); } catch { path = null; }
  if (path !== null) {
    pinned = true;
  } else {
    const info = await paneProcessInfo(pane.pane_id).catch(() => null);
    const locks = kimiSessionIdsByPid(home);
    if (locks.size > 0) {
      const shellPid = typeof info?.shell_pid === "number" && Number.isSafeInteger(info.shell_pid) && info.shell_pid > 1 ? info.shell_pid : null;
      const candidates = [...new Set([
        ...(shellPid !== null ? [shellPid] : []),
        ...(info?.foreground_processes ?? []).map((process) => process.pid),
        ...(shellPid !== null ? processTree(shellPid) : []),
      ])].filter((pid): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1);
      for (const pid of candidates) {
        const sessionId = locks.get(pid);
        if (sessionId === undefined) continue;
        path = kimiWireForSessionId(sessionId, home);
        if (path !== null) break;
      }
    }
  }
  paneResolution.set(pane.pane_id, { path, at: now, pinned });
  return path;
}

/** The text of a user message: Kimi stores content as parts, older ones as a plain string. */
export function kimiUserText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts = content.filter((part): part is { type: "text"; text: string } =>
    part !== null && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string");
  return texts.length === 0 ? null : texts.map((part) => part.text).join("\n");
}

/** The ISO time of a record's millisecond epoch, null when it is not a sane epoch. */
function kimiWireTs(time: unknown): string | null {
  return typeof time === "number" && Number.isSafeInteger(time) && Math.abs(time) <= 8.64e15 ? new Date(time).toISOString() : null;
}

/** A short rendering of a tool call for the fold: a command is its command line, else its name. */
function kimiToolSummary(event: { name?: unknown; display?: { kind?: unknown; command?: unknown } }): string {
  const display = event.display;
  if (display?.kind === "command" && typeof display.command === "string" && display.command.length > 0) return display.command;
  return typeof event.name === "string" ? event.name : "tool";
}

/** tool.result records name the call by Kimi's own toolCallId. */
type PendingTool = Extract<ConversationPart, { kind: "tool" }> & { state: "pending" | "ok" | "error" };

/**
 * wire.jsonl records, one per line: user prompts are `context.append_message`
 * records; the answer loop is `context.append_loop_event` records — `content.part`
 * (text or think), `tool.call` and its later `tool.result`, all carrying the loop's
 * `time`. Everything between two user prompts is one assistant turn. A stored user
 * message whose `origin.kind` is not "user" (injections, task notifications, cron
 * firings) is meta traffic and never becomes a turn. A record whose shape is wrong
 * (a `null` line, a wild timestamp) is skipped, never fails the page; a tool result
 * is cut like the other readers' (trimOutput), the rest fetched by its toolCallId.
 */
export function parseKimiTranscript(text: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  const pending = new Map<string, PendingTool>();
  let current: ConversationTurn | null = null;
  const ensureAssistant = (ts: string | null): ConversationTurn => {
    if (current === null) current = { role: "assistant", ts, parts: [] };
    if (current.ts === null && ts !== null) current.ts = ts;
    return current;
  };
  const flush = (): void => {
    if (current !== null && current.parts.length > 0) turns.push(current);
    current = null;
  };
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    let record: {
      type?: unknown; time?: unknown;
      message?: { role?: unknown; content?: unknown; origin?: { kind?: unknown } };
      event?: {
        type?: unknown; part?: { type?: unknown; text?: unknown; think?: unknown };
        toolCallId?: unknown; name?: unknown; args?: unknown; display?: { kind?: unknown; command?: unknown };
        result?: { output?: unknown; error?: unknown };
      };
    } | null;
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    if (record === null || typeof record !== "object") continue;
    const ts = kimiWireTs(record.time);
    if (record.type === "context.append_message") {
      if (record.message?.role !== "user") continue;
      // The CLI tags every stored message with its origin: only the user's own
      // input belongs in the chat. Injections (AGENTS.md, system reminders),
      // task notifications and cron firings stay invisible, like other agents'
      // meta entries; records from older CLIs without an origin still pass.
      const originKind = record.message.origin?.kind;
      if (typeof originKind === "string" && originKind !== "user") continue;
      flush();
      const body = kimiUserText(record.message.content);
      turns.push({ role: "user", ts, parts: body === null ? [] : [{ kind: "text", text: body }] });
      continue;
    }
    if (record.type !== "context.append_loop_event" || record.event === null || typeof record.event !== "object") continue;
    const event = record.event;
    if (event.type === "content.part") {
      const part = event.part;
      if (part?.type === "text" && typeof part.text === "string" && part.text.length > 0) {
        ensureAssistant(ts).parts.push({ kind: "text", text: part.text });
      } else if (part?.type === "think" && typeof part.think === "string" && part.think.length > 0) {
        ensureAssistant(ts).parts.push({ kind: "thinking", text: part.think });
      }
    } else if (event.type === "tool.call") {
      const tool: PendingTool = {
        kind: "tool",
        name: typeof event.name === "string" ? event.name : "tool",
        summary: kimiToolSummary(event),
        input: typeof event.args === "string" ? event.args : JSON.stringify(event.args ?? {}),
        output: "",
        state: "pending",
      };
      if (typeof event.toolCallId === "string") tool.call_id = event.toolCallId;
      ensureAssistant(ts).parts.push(tool);
      if (tool.call_id !== undefined) pending.set(tool.call_id, tool);
    } else if (event.type === "tool.result") {
      const tool = typeof event.toolCallId === "string" ? pending.get(event.toolCallId) : undefined;
      if (tool === undefined) continue;
      const output = event.result?.output;
      trimOutput(tool, typeof output === "string" ? output : JSON.stringify(output ?? ""), event.toolCallId as string);
      tool.state = event.result?.error ? "error" : "ok";
      if (tool.state === "error") tool.error = true;
      pending.delete(event.toolCallId as string);
    }
  }
  flush();
  return turns;
}
