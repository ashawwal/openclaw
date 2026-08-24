// Matrix plugin module implements test events behavior.
import type { MatrixRawEvent } from "./types.js";

type BundledReplacementEventOptions = {
  content?: Record<string, unknown>;
  replacementContent?: Record<string, unknown>;
  replacement?: Partial<MatrixRawEvent>;
  redacted?: boolean;
};

export function createBundledReplacementEvent(
  eventId: string,
  options: BundledReplacementEventOptions = {},
): MatrixRawEvent {
  const replacement: MatrixRawEvent = {
    event_id: "$edit",
    sender: "@alice:example.org",
    type: "m.room.message",
    origin_server_ts: 200,
    content: {
      msgtype: "m.text",
      body: "* edited text",
      "m.new_content": { msgtype: "m.text", body: "edited text" },
      "m.relates_to": { rel_type: "m.replace", event_id: eventId },
      ...options.replacementContent,
    },
    ...options.replacement,
  };

  return {
    event_id: eventId,
    sender: "@alice:example.org",
    type: "m.room.message",
    origin_server_ts: 100,
    content: options.content ?? { msgtype: "m.text", body: "original text" },
    unsigned: {
      ...(options.redacted ? { redacted_because: { event_id: "$redaction" } } : {}),
      "m.relations": { "m.replace": replacement },
    },
  };
}

export const bundledReplacementContentCases = [
  {
    name: "text",
    options: {},
    expected: "edited text",
  },
  {
    name: "media caption",
    options: {
      content: { msgtype: "m.image", body: "before.jpg", filename: "before.jpg" },
      replacementContent: {
        "m.new_content": {
          msgtype: "m.image",
          body: "edited caption",
          filename: "after.jpg",
        },
      },
    },
    expected: "edited caption\n\n[matrix image attachment]",
  },
] satisfies Array<{
  name: string;
  options: BundledReplacementEventOptions;
  expected: string;
}>;

export const invalidBundledReplacementCases = [
  {
    name: "another sender",
    options: { replacement: { sender: "@mallory:example.org" } },
  },
  {
    name: "another target",
    options: {
      replacementContent: {
        "m.relates_to": { rel_type: "m.replace", event_id: "$different" },
      },
    },
  },
  {
    name: "another event type",
    options: { replacement: { type: "m.room.notice" } },
  },
  {
    name: "a redacted replacement",
    options: {
      replacement: { unsigned: { redacted_because: { event_id: "$redaction" } } },
    },
  },
] satisfies Array<{ name: string; options: BundledReplacementEventOptions }>;

export function createPollStartEvent(eventId: string): MatrixRawEvent {
  return {
    event_id: eventId,
    sender: "@alice:example.org",
    type: "m.poll.start",
    origin_server_ts: Date.now(),
    content: {
      "m.poll.start": {
        question: { "m.text": "Lunch?" },
        kind: "m.poll.disclosed",
        max_selections: 1,
        answers: [
          { id: "a1", "m.text": "Pizza" },
          { id: "a2", "m.text": "Sushi" },
        ],
      },
    },
  };
}
