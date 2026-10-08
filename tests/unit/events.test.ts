// Unit tests for the session-event projections (`dsh/events.ts`).
//
// The turn-reason table is the ADR-0003 §3.2 mapping and it **exhausts the official
// `TurnEndReasonMap`**: every member has a row here, `blocked`/`max-tokens` are failures (they
// used to be judged successful), and any kind DSH adds later fails closed.
import { describe, expect, it } from "vitest";
import {
  lastTurnEndOutcome,
  lastTurnEndReason,
  projectAssistantText,
  recordText,
  turnEndOutcome,
  type TurnEndContext,
  type TurnEndReason,
} from "../../src/dsh/events.js";
import type { HistoryEvent } from "../../src/dsh/types.js";
import "../support/isolation.js";

const PASSIVE: TurnEndContext = { cancelRequested: false };
const CANCELLING: TurnEndContext = { cancelRequested: true };

function reason(kind: string, cause: string | null = null, error: unknown = undefined): TurnEndReason {
  return { kind, cause, error };
}

/** The wire shape of one `turn/end` event: `aborted` carries its cause at `reason.reason.kind`. */
function turnEnd(value: TurnEndReason, seq = 1): HistoryEvent {
  return {
    event: {
      type: "turn/end",
      seq,
      data: {
        turn: 1,
        reason: {
          kind: value.kind,
          ...(value.cause === null ? {} : { reason: { kind: value.cause } }),
          ...(value.error === undefined ? {} : { error: value.error }),
        },
      },
    },
  };
}

function assistantMessage(texts: string[], seq = 1): HistoryEvent {
  return {
    event: {
      type: "assistant/message",
      seq,
      data: { turn: 1, step: 1, stream: [], message: { content: texts.map((text) => ({ type: "text", text })) } },
    },
  };
}

describe("dsh/events turnEndOutcome — the official reason map, fail-closed", () => {
  it.each([
    {
      label: "completed is the only success",
      input: reason("completed"),
      context: PASSIVE,
      expected: { kind: "succeeded" },
    },
    {
      label: "error with a code becomes rpc:<code>",
      input: reason("error", null, { code: "MISSING_CREDENTIAL", message: "no API key for provider route" }),
      context: PASSIVE,
      expected: { kind: "failed", reason: "rpc:MISSING_CREDENTIAL" },
    },
    {
      label: "error without a code stays recognizable",
      input: reason("error", null, "plain string failure"),
      context: PASSIVE,
      expected: { kind: "failed", reason: "turn-unknown:error" },
    },
    {
      label: "blocked is a failure, not a success",
      input: reason("blocked"),
      context: PASSIVE,
      expected: { kind: "failed", reason: "turn-blocked" },
    },
    {
      label: "max-tokens is a failure, not a success",
      input: reason("max-tokens"),
      context: PASSIVE,
      expected: { kind: "failed", reason: "turn-truncated" },
    },
    {
      label: "aborted by the user is a cancellation",
      input: reason("aborted", "user"),
      context: PASSIVE,
      expected: { kind: "cancelled" },
    },
    {
      label: "aborted by the parent is a failure",
      input: reason("aborted", "parent"),
      context: PASSIVE,
      expected: { kind: "failed", reason: "turn-aborted:parent" },
    },
    {
      label: "aborted by a hook is a failure",
      input: reason("aborted", "hook"),
      context: PASSIVE,
      expected: { kind: "failed", reason: "turn-aborted:hook" },
    },
    {
      label: "aborted as disposed is a failure (there is no top-level disposed kind)",
      input: reason("aborted", "disposed"),
      context: PASSIVE,
      expected: { kind: "failed", reason: "turn-aborted:disposed" },
    },
    {
      label: "aborted as legacy is a failure",
      input: reason("aborted", "legacy"),
      context: PASSIVE,
      expected: { kind: "failed", reason: "turn-aborted:legacy" },
    },
    {
      label: "aborted without a cause but with a local cancel is a cancellation",
      input: reason("aborted"),
      context: CANCELLING,
      expected: { kind: "cancelled" },
    },
    {
      label: "aborted without a cause and without a local cancel still fails",
      input: reason("aborted"),
      context: PASSIVE,
      expected: { kind: "failed", reason: "turn-aborted:unknown" },
    },
    {
      label: "interrupted is a failure",
      input: reason("interrupted"),
      context: PASSIVE,
      expected: { kind: "failed", reason: "turn-interrupted" },
    },
    {
      label: "forked is not a success",
      input: reason("forked"),
      context: PASSIVE,
      expected: { kind: "failed", reason: "turn-unknown:forked" },
    },
    {
      label: "a kind this project has never seen fails closed",
      input: reason("something-new"),
      context: PASSIVE,
      expected: { kind: "failed", reason: "turn-unknown:something-new" },
    },
  ])("$label", ({ input, context, expected }) => {
    expect(turnEndOutcome(input, context)).toMatchObject(expected);
  });

  it("keeps the operator text of each failure actionable", () => {
    expect(turnEndOutcome(reason("error", null, { code: "MISSING_CREDENTIAL", message: "no API key" }), PASSIVE))
      .toMatchObject({ message: "no API key (code: MISSING_CREDENTIAL)" });
    expect(turnEndOutcome(reason("error", null, { code: "X" }), PASSIVE))
      .toMatchObject({ message: "DeepSeek Harness turn failed. (code: X)" });
    expect(turnEndOutcome(reason("blocked"), PASSIVE)).toMatchObject({ message: /blocked/u });
    expect(turnEndOutcome(reason("max-tokens"), PASSIVE)).toMatchObject({ message: /token limit/u });
    expect(turnEndOutcome(reason("aborted", "parent"), PASSIVE)).toMatchObject({ message: /aborted \(parent\)/u });
    expect(turnEndOutcome(reason("interrupted"), PASSIVE)).toMatchObject({ message: /turn ended with interrupted/u });
    expect(turnEndOutcome(reason("something-new"), PASSIVE)).toMatchObject({ message: /unrecognized reason/u });
  });
});

describe("dsh/events turn/end reading", () => {
  it("reads the last turn/end in the window and its nested abort cause", () => {
    const events = [turnEnd(reason("completed"), 1), turnEnd(reason("aborted", "parent"), 2)];

    expect(lastTurnEndReason(events)).toEqual({ kind: "aborted", cause: "parent", error: undefined });
    expect(lastTurnEndOutcome(events, PASSIVE)).toMatchObject({ kind: "failed", reason: "turn-aborted:parent" });
  });

  it("returns null when the window has no usable terminal turn", () => {
    expect(lastTurnEndReason([])).toBeNull();
    expect(lastTurnEndReason([assistantMessage(["still running"])])).toBeNull();
    expect(lastTurnEndReason([{ event: { type: "turn/end", seq: 1, data: null } }])).toBeNull();
    expect(lastTurnEndReason([{ event: { type: "turn/end", seq: 1, data: {} } }])).toBeNull();
    expect(lastTurnEndReason([{ event: { type: "turn/end", seq: 1, data: { reason: { kind: 3 } } } }])).toBeNull();
    expect(lastTurnEndOutcome([assistantMessage(["still running"])], PASSIVE)).toBeNull();
  });
});

describe("dsh/events projectAssistantText", () => {
  it("joins every text block of every assistant message in event order", () => {
    const events = [
      assistantMessage(["first", "second"], 1),
      { event: { type: "user/message", seq: 2, data: {} } },
      assistantMessage(["third"], 3),
    ];
    expect(projectAssistantText(events)).toBe("first\nsecond\nthird");
  });

  it("ignores non-text blocks and malformed messages", () => {
    const events: HistoryEvent[] = [
      {
        event: {
          type: "assistant/message",
          seq: 1,
          data: { message: { content: [{ type: "tool-call" }, { type: "text", text: "kept" }] } },
        },
      },
      { event: { type: "assistant/message", seq: 2, data: { message: { content: "not-an-array" } } } },
      { event: { type: "assistant/message", seq: 3, data: null } },
      { event: { type: "assistant/message", seq: 4, data: { message: null } } },
    ];
    expect(projectAssistantText(events)).toBe("kept");
  });

  it("returns the empty string when there is no assistant text", () => {
    expect(projectAssistantText([])).toBe("");
  });
});

describe("dsh/events recordText", () => {
  it("accepts strings, message fields, and error fields only", () => {
    expect(recordText("direct")).toBe("direct");
    expect(recordText({ message: "from message" })).toBe("from message");
    expect(recordText({ error: "from error" })).toBe("from error");
    expect(recordText({ other: "ignored" })).toBeNull();
    expect(recordText(null)).toBeNull();
    expect(recordText(7)).toBeNull();
  });
});
