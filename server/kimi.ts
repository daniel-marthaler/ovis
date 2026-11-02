/**
 * Kimi Code keeps one append-only wire log per agent session:
 * `~/.kimi-code/sessions/wd_<dir-name>_<sha256(cwd)[:12]>/session_<id>/agents/<agent>/wire.jsonl`.
 * This file reads that log into conversation turns for the chat view.
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { ConversationPart, ConversationTurn } from "../shared/protocol.ts";

/** The store directory Kimi Code derives from a working directory. */
export function kimiSessionsDir(cwd: string, home = homedir()): string {
  const key = createHash("sha256").update(cwd).digest("hex").slice(0, 12);
  return join(home, ".kimi-code", "sessions", `wd_${basename(cwd)}_${key}`);
}

/**
 * The wire log of the newest session started in `cwd`, null when Kimi Code never
 * wrote one there. A pane's process does not hold the log open (the CLI appends
 * and closes), so the newest file by mtime is the live session; the others are
 * sessions that ended. When two panes share one cwd they read the same newest
 * session until the second one writes — a known ambiguity of a store that keeps
 * no process binding.
 */
export function kimiTranscriptPath(cwd: string, home = homedir()): string | null {
  if (typeof cwd !== "string" || cwd.length === 0) return null;
  let names: string[];
  try { names = readdirSync(kimiSessionsDir(cwd, home)); } catch { return null; }
  let best: { path: string; mtimeMs: number } | null = null;
  for (const name of names) {
    if (!name.startsWith("session_")) continue;
    const path = join(kimiSessionsDir(cwd, home), name, "agents", "main", "wire.jsonl");
    try {
      const mtimeMs = statSync(path).mtimeMs;
      if (best === null || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    } catch { /* a session dir without the main agent's log */ }
  }
  return best?.path ?? null;
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
