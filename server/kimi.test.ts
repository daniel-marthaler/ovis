import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kimiSessionIdsByPid, kimiSessionsDir, kimiUserText, parseKimiTranscript } from "./kimi.ts";
import { TOOL_OUTPUT_CHARS } from "./tool-output.ts";
import { turnStarts } from "./transcript-turns.ts";

it("derives the session directory the way Kimi Code does", () => {
  expect(kimiSessionsDir("/home/mad", "/home/mad/fake-home")).toBe(
    "/home/mad/fake-home/.kimi-code/sessions/wd_mad_6c73d0ee67aa");
});

function fakeSession(home: string, cwd: string, session: string, mtime: Date, createdAt?: number): string {
  const path = join(kimiSessionsDir(cwd, home), session, "agents", "main", "wire.jsonl");
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, createdAt !== undefined ? `${JSON.stringify({ type: "metadata", created_at: createdAt })}\n` : "");
  utimesSync(path, mtime, mtime);
  return path;
}

it("reads a user message from parts or a plain string", () => {
  expect(kimiUserText("Hallo")).toBe("Hallo");
  expect(kimiUserText([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  expect(kimiUserText([{ type: "image" }])).toBeNull();
  expect(kimiUserText(undefined)).toBeNull();
});

const WIRE = [
  { type: "metadata", protocol_version: "1.5", created_at: 1793439028458 },
  { type: "context.append_message", agentId: "main", message: { role: "user", content: [{ type: "text", text: "Sag Hallo" }] } },
  { type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "think", think: "ueberlege" } }, time: 1793439030000 },
  { type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "text", text: "Hallo!" } }, time: 1793439031000 },
  { type: "context.append_loop_event", agentId: "main", event: { type: "tool.call", toolCallId: "tool_1", name: "Bash", args: { command: "echo hi" }, display: { kind: "command", command: "echo hi" } }, time: 1793439032000 },
  { type: "context.append_loop_event", agentId: "main", event: { type: "tool.result", toolCallId: "tool_1", result: { output: "hi\n" } }, time: 1793439033000 },
  { type: "context.append_loop_event", agentId: "main", event: { type: "tool.call", toolCallId: "tool_2", name: "Read", args: { path: "/x" } }, time: 1793439034000 },
  { type: "context.append_loop_event", agentId: "main", event: { type: "tool.result", toolCallId: "tool_2", result: { output: "kaputt", error: true } }, time: 1793439035000 },
  { type: "context.append_message", agentId: "main", message: { role: "user", content: "Und Tschau" } },
  { type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "text", text: "Tschau!" } }, time: 1793439036000 },
].map((record) => JSON.stringify(record)).join("\n");

it("parses wire.jsonl into user and assistant turns", () => {
  const turns = parseKimiTranscript(WIRE);
  expect(turns).toHaveLength(4);

  expect(turns[0]!.role).toBe("user");
  expect(turns[0]!.parts).toEqual([{ kind: "text", text: "Sag Hallo" }]);

  const answer = turns[1]!;
  expect(answer.role).toBe("assistant");
  expect(answer.ts).toBe(new Date(1793439030000).toISOString());
  expect(answer.parts[0]).toEqual({ kind: "thinking", text: "ueberlege" });

  const bash = answer.parts.find((part) => part.kind === "tool" && part.name === "Bash");
  expect(bash).toMatchObject({ kind: "tool", summary: "echo hi", input: JSON.stringify({ command: "echo hi" }), output: "hi\n", state: "ok", call_id: "tool_1" });

  const read = answer.parts.find((part) => part.kind === "tool" && part.name === "Read");
  expect(read).toMatchObject({ kind: "tool", summary: "Read", output: "kaputt", state: "error", error: true });

  expect(turns[2]!.role).toBe("user");
  expect(turns[2]!.parts).toEqual([{ kind: "text", text: "Und Tschau" }]);
  expect(turns[3]!.role).toBe("assistant");
  expect(turns[3]!.parts).toEqual([{ kind: "text", text: "Tschau!" }]);
});

it("leaves a tool call pending when no result followed it", () => {
  const wire = [
    { type: "context.append_message", message: { role: "user", content: "x" } },
    { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "tool_9", name: "Bash", args: { command: "sleep 9" } } },
  ].map((record) => JSON.stringify(record)).join("\n");
  const turns = parseKimiTranscript(wire);
  expect(turns[1]!.parts[0]).toMatchObject({ kind: "tool", state: "pending", output: "" });
});

it("skips broken lines without losing the turn structure", () => {
  const turns = parseKimiTranscript(`{not json}\n${JSON.stringify({ type: "context.append_message", message: { role: "user", content: "hi" } })}\n`);
  expect(turns).toHaveLength(1);
  expect(turns[0]!.parts).toEqual([{ kind: "text", text: "hi" }]);
});

it("drops meta traffic: only the user's own input becomes a turn", () => {
  const wire = [
    { type: "context.append_message", message: { role: "user", origin: { kind: "injection", variant: "system_reminder" }, content: [{ type: "text", text: "<system-reminder>The date has changed</system-reminder>" }] } },
    { type: "context.append_message", message: { role: "user", origin: { kind: "injection", variant: "agents_md" }, content: [{ type: "text", text: "# AGENTS.md" }] } },
    { type: "context.append_message", message: { role: "user", origin: { kind: "task", taskId: "bash-1", status: "completed" }, content: [{ type: "text", text: "<notification id=\"task:bash-1:completed\">" }] } },
    { type: "context.append_message", message: { role: "user", origin: { kind: "cron_job", jobId: "j1" }, content: [{ type: "text", text: "<cron-fire jobId=\"j1\">" }] } },
    { type: "context.append_message", message: { role: "user", origin: { kind: "skill_activation" }, content: [{ type: "text", text: "skill" }] } },
    { type: "context.append_message", message: { role: "user", origin: { kind: "user" }, content: [{ type: "text", text: "Echte Frage" }] } },
    { type: "context.append_loop_event", agentId: "main", event: { type: "content.part", part: { type: "text", text: "Antwort" } }, time: 1793439036000 },
  ].map((record) => JSON.stringify(record)).join("\n");
  const turns = parseKimiTranscript(wire);
  expect(turns).toHaveLength(2);
  expect(turns[0]).toEqual({ role: "user", ts: null, parts: [{ kind: "text", text: "Echte Frage" }] });
  expect(turns[1]!.role).toBe("assistant");
  // The meta lines open no turn start either, for the incremental scanner.
  expect(turnStarts(Buffer.from(wire), "kimi-transcript")).toHaveLength(1);
});

it("marks user prompts as turn starts for the transcript scanner", () => {
  const bytes = Buffer.from(WIRE);
  const starts = turnStarts(bytes, "kimi-transcript");
  expect(starts).toHaveLength(2);
  expect(bytes.subarray(starts[0]!).toString("utf8")).toContain("Sag Hallo");
  expect(bytes.subarray(starts[1]!).toString("utf8")).toContain("Und Tschau");
});

it("lock files map a pid to its own session, the index maps it to the wire log", async () => {
  const { kimiSessionIdsByPid, kimiWireForSessionId } = await import("./kimi.ts");
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kimi-locks-")));
  try {
    const wire = fakeSession(home, "/home/mad", "session_cccccccc-cccc-cccc-cccc-cccccccccccc", new Date("2026-11-01T10:00:00Z"), Date.parse("2026-11-01T09:00:00Z"));
    const locksDir = join(home, ".kimi-code", "locks", "sessions");
    mkdirSync(locksDir, { recursive: true });
    writeFileSync(join(locksDir, "session_cccccccc-cccc-cccc-cccc-cccccccccccc.lock"), JSON.stringify({ version: 1, pid: 4242 }));
    const byPid = kimiSessionIdsByPid(home);
    expect(byPid.get(4242)).toBe("session_cccccccc-cccc-cccc-cccc-cccccccccccc");
    expect(byPid.get(9999)).toBeUndefined();
    // via the index
    writeFileSync(join(home, ".kimi-code", "session_index.jsonl"), `${JSON.stringify({ sessionId: "session_cccccccc-cccc-cccc-cccc-cccccccccccc", sessionDir: join(home, ".kimi-code", "sessions", "wd_mad_6c73d0ee67aa", "session_cccccccc-cccc-cccc-cccc-cccccccccccc"), workDir: "/home/mad" })}\n`);
    expect(kimiWireForSessionId("session_cccccccc-cccc-cccc-cccc-cccccccccccc", home)).toBe(wire);
    // without the index, the store scan finds it
    rmSync(join(home, ".kimi-code", "session_index.jsonl"));
    expect(kimiWireForSessionId("session_cccccccc-cccc-cccc-cccc-cccccccccccc", home)).toBe(wire);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("a pid two locks claim is mapped by the newest lock, not a stale one", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kimi-locks-")));
  try {
    const locksDir = join(home, ".kimi-code", "locks", "sessions");
    mkdirSync(locksDir, { recursive: true });
    const stale = join(locksDir, "session_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.lock");
    const live = join(locksDir, "session_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.lock");
    writeFileSync(stale, JSON.stringify({ version: 1, pid: 4242 }));
    writeFileSync(live, JSON.stringify({ version: 1, pid: 4242 }));
    utimesSync(stale, new Date("2026-10-30T08:00:00Z"), new Date("2026-10-30T08:00:00Z"));
    utimesSync(live, new Date("2026-11-04T08:00:00Z"), new Date("2026-11-04T08:00:00Z"));
    expect(kimiSessionIdsByPid(home).get(4242)).toBe("session_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("cuts a long tool result like the other readers, whole output kept behind the toolCallId", () => {
  const long = "x".repeat(TOOL_OUTPUT_CHARS * 3);
  const wire = [
    { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "tool_big", name: "Bash", args: { command: "big" } } },
    { type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "tool_big", result: { output: long } } },
    { type: "context.append_loop_event", event: { type: "tool.call", toolCallId: "tool_small", name: "Bash", args: { command: "small" } } },
    { type: "context.append_loop_event", event: { type: "tool.result", toolCallId: "tool_small", result: { output: "ok" } } },
  ].map((record) => JSON.stringify(record)).join("\n");
  const tools = parseKimiTranscript(wire).flatMap((turn) => turn.parts).filter((part) => part.kind === "tool");
  expect(tools.map((tool) => [tool.output_ref, tool.output_size])).toEqual([["tool_big", long.length], [undefined, undefined]]);
  expect(tools[0]!.output.endsWith("… trimmed")).toBe(true);
  expect(tools[1]).toMatchObject({ output: "ok", state: "ok" });
});

it("skips a null record and a wild timestamp instead of failing the page", () => {
  const wire = [
    "null",
    JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "vorher" } }, time: 9e18 }),
    JSON.stringify({ type: "context.append_message", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "context.append_loop_event", event: { type: "content.part", part: { type: "text", text: "Antwort" } }, time: 1793439036000 }),
  ].join("\n");
  const turns = parseKimiTranscript(wire);
  expect(turns).toHaveLength(3);
  expect(turns[0]).toEqual({ role: "assistant", ts: null, parts: [{ kind: "text", text: "vorher" }] });
  expect(turns[1]!.parts).toEqual([{ kind: "text", text: "hi" }]);
  expect(turns[2]).toEqual({ role: "assistant", ts: new Date(1793439036000).toISOString(), parts: [{ kind: "text", text: "Antwort" }] });
});
