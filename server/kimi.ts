/**
 * Kimi Code keeps one append-only wire log per agent session:
 * `~/.kimi-code/sessions/wd_<dir-name>_<sha256(cwd)[:12]>/<session>/agents/<agent>/wire.jsonl`.
 * This file reads that log into conversation turns for the chat view.
 */
import { createHash } from "node:crypto";
import { opendirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";
import type { HerdrPane } from "../shared/protocol.ts";
import { paneProcessInfo } from "./herdr/client.ts";

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
  const map = new Map<number, string>();
  let names: string[];
  try { names = readdirSync(join(home, ".kimi-code", "locks", "sessions")); } catch { return map; }
  for (const name of names) {
    if (!name.endsWith(".lock")) continue;
    try {
      const lock = JSON.parse(readFileSync(join(home, ".kimi-code", "locks", "sessions", name), "utf8")) as { pid?: unknown };
      if (Number.isSafeInteger(lock.pid) && (lock.pid as number) > 1) map.set(lock.pid as number, name.slice(0, -".lock".length));
    } catch { /* a lock half-written: the next read has it whole */ }
  }
  return map;
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

/** The session's own creation time from its metadata record (first line), null when unreadable. */
function kimiWireCreatedAt(path: string): number | null {
  let head: string;
  try { head = readFileSync(path, "utf8").slice(0, 65536); } catch { return null; }
  const newline = head.indexOf("\n");
  if (newline === -1) return null;
  try {
    const record = JSON.parse(head.slice(0, newline)) as { type?: unknown; created_at?: unknown };
    return record.type === "metadata" && typeof record.created_at === "number" ? record.created_at : null;
  } catch { return null; }
}

/**
 * The session a pane started in `cwd`, or null when Kimi Code never wrote one there.
 * With `startedAtMs` (the pane shell's start), the newest session created at or before it wins —
 * a pane keeps its own session even after another pane in the same cwd wrote a newer one. Without
 * it, the newest mtime stands in. The CLI appends and closes, so the frontend process holds no
 * open file to follow on platforms without /proc.
 */
export function kimiTranscriptPath(cwd: string, home = homedir(), startedAtMs: number | null = null): string | null {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const root = kimiSessionsDir(cwd, home);
  let names: string[];
  try { names = readdirSync(root); } catch { return null; }
  let best: { path: string; rank: number } | null = null;
  for (const name of names) {
    if (!name.startsWith("session_")) continue;
    const path = join(root, name, "agents", "main", "wire.jsonl");
    let rank: number;
    try {
      rank = statSync(path).mtimeMs;
    } catch { continue; /* a session dir without the main agent's log */ }
    if (startedAtMs !== null) {
      const createdAt = kimiWireCreatedAt(path);
      // only sessions the pane could have started; newer ones belong to a later pane
      if (createdAt === null || createdAt > startedAtMs + 10_000) continue;
      rank = createdAt;
    }
    if (best === null || rank > best.rank) best = { path, rank };
  }
  return best?.path ?? null;
}

/** The shell's start time as the /proc entry's ctime, null when unavailable. */
function processStartedAtMs(pid: number): number | null {
  try { return statSync(`/proc/${pid}`).ctimeMs; } catch { return null; }
}

/**
 * The session created closest before `startedAtMs` (a pane's process starts just before its CLI
 * writes the session's metadata), when that lead is small; null otherwise — a session far older
 * than the process is a resumed one, and time says nothing about which pane resumed it.
 */
export function kimiTranscriptPathNearStart(cwd: string, startedAtMs: number, home = homedir()): string | null {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  const root = kimiSessionsDir(cwd, home);
  let names: string[];
  try { names = readdirSync(root); } catch { return null; }
  let best: { path: string; lead: number } | null = null;
  for (const name of names) {
    if (!name.startsWith("session_")) continue;
    const path = join(root, name, "agents", "main", "wire.jsonl");
    try { statSync(path); } catch { continue; }
    const createdAt = kimiWireCreatedAt(path);
    if (createdAt === null) continue;
    const lead = startedAtMs - createdAt;
    if (lead < -5_000 || lead > 120_000) continue;
    if (best === null || lead < best.lead) best = { path, lead };
  }
  return best?.path ?? null;
}

const paneResolution = new Map<string, { path: string; at: number; pinned: boolean }>();
const RESOLVE_TTL_MS = 15_000;
const PIN_VERIFY_MS = 30_000;

/**
 * The wire log for the pane, in order of evidence:
 *
 * 1. A file-descriptor match in the pane's process tree. The CLI appends and closes, so the log
 *    is open only in write bursts; the first match therefore pins the pane's session until a
 *    different match replaces it (a /clear in the pane).
 * 2. A session created just before the pane's foreground process started — a new CLI makes its
 *    session within seconds of its own start (this is what separates two panes in one cwd).
 * 3. The newest session started at or before the foreground process, then the shell.
 *
 * Answers are cached briefly; unpinned entries follow the TTL, a pin is re-verified on its own
 * interval and kept when no fresh fd evidence says otherwise.
 */
export async function kimiTranscriptPathForPane(pane: HerdrPane, cwd: string, home = homedir()): Promise<string | null> {
  const now = Date.now();
  const cached = paneResolution.get(pane.pane_id);
  if (cached !== undefined && (cached.pinned ? now - cached.at < PIN_VERIFY_MS : now - cached.at < RESOLVE_TTL_MS)) return cached.path;
  let path: string | null = null;
  let pinned = false;
  try { path = await kimiPathFromProcessTree(pane.pane_id); } catch { path = null; }
  if (path !== null) {
    pinned = true;
  } else {
    // the CLI's lock files name the owner pid of each live session: the strongest steady evidence
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
    const foreground = (info?.foreground_processes ?? [])[0];
    const fgStart = foreground !== undefined && Number.isSafeInteger(foreground.pid) && foreground.pid > 1 ? processStartedAtMs(foreground.pid) : null;
    if (path === null && fgStart !== null) {
      path = kimiTranscriptPathNearStart(cwd, fgStart, home)
        ?? (typeof pane.foreground_cwd === "string" && pane.foreground_cwd.length > 0 ? kimiTranscriptPathNearStart(pane.foreground_cwd, fgStart, home) : null);
    }
    if (path === null) {
      const shell = info?.shell_pid;
      const startedAtMs = typeof shell === "number" && Number.isSafeInteger(shell) && shell > 1 ? processStartedAtMs(shell) : null;
      const cwds = [cwd, typeof pane.foreground_cwd === "string" && pane.foreground_cwd.length > 0 ? pane.foreground_cwd : ""];
      for (const candidate of cwds) {
        path = kimiTranscriptPath(candidate, home, startedAtMs);
        if (path !== null) break;
      }
    }
  }
  paneResolution.set(pane.pane_id, { path: path ?? "", at: now, pinned });
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
 * `time`. Everything between two user prompts is one assistant turn.
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
      message?: { role?: unknown; content?: unknown };
      event?: {
        type?: unknown; part?: { type?: unknown; text?: unknown; think?: unknown };
        toolCallId?: unknown; name?: unknown; args?: unknown; display?: { kind?: unknown; command?: unknown };
        result?: { output?: unknown; error?: unknown };
      };
    };
    try { record = JSON.parse(line) as typeof record; } catch { continue; }
    const ts = typeof record.time === "number" ? new Date(record.time).toISOString() : null;
    if (record.type === "context.append_message") {
      if (record.message?.role !== "user") continue;
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
      tool.output = typeof output === "string" ? output : JSON.stringify(output ?? "");
      tool.state = event.result?.error ? "error" : "ok";
      if (tool.state === "error") tool.error = true;
      pending.delete(event.toolCallId as string);
    }
  }
  flush();
  return turns;
}
