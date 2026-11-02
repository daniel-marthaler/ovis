import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { kimiSessionsDir, kimiTranscriptPath, kimiUserText, parseKimiTranscript } from "./kimi.ts";
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

it("with a pane start time, picks the newest session started at or before it", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kimi-store-")));
  try {
    const older = fakeSession(home, "/home/mad", "session_11111111-1111-1111-1111-111111111111", new Date("2026-11-01T10:00:00Z"), Date.parse("2026-11-01T09:00:00Z"));
    const newer = fakeSession(home, "/home/mad", "session_22222222-2222-2222-2222-222222222222", new Date("2026-11-02T10:00:00Z"), Date.parse("2026-11-02T09:00:00Z"));
    // a pane up since Nov 1 noon can only have started the older session
    expect(kimiTranscriptPath("/home/mad", home, Date.parse("2026-11-01T12:00:00Z"))).toBe(older);
    // a pane that started later may have started either; the newer one wins
    expect(kimiTranscriptPath("/home/mad", home, Date.parse("2026-11-03T12:00:00Z"))).toBe(newer);
    // without a start time the newest mtime stands in
    expect(kimiTranscriptPath("/home/mad", home)).toBe(newer);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

it("returns null without a store and the newest session when there are several", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "kimi-store-")));
  try {
    expect(kimiTranscriptPath("/home/mad", home)).toBeNull();
    const older = fakeSession(home, "/home/mad", "session_11111111-1111-1111-1111-111111111111", new Date("2026-11-01T10:00:00Z"));
    const newer = fakeSession(home, "/home/mad", "session_22222222-2222-2222-2222-222222222222", new Date("2026-11-02T10:00:00Z"));
    expect(kimiTranscriptPath("/home/mad", home)).toBe(newer);
    expect(kimiTranscriptPath("/home/mad", home)).not.toBe(older);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

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

it("marks user prompts as turn starts for the transcript scanner", () => {
  const bytes = Buffer.from(WIRE);
  const starts = turnStarts(bytes, "kimi-transcript");
  expect(starts).toHaveLength(2);
  expect(bytes.subarray(starts[0]!).toString("utf8")).toContain("Sag Hallo");
  expect(bytes.subarray(starts[1]!).toString("utf8")).toContain("Und Tschau");
});
