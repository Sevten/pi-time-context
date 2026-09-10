import { describe, expect, it } from "vitest";
import { prependStamp, transformContextMessages } from "../src/context-transform.js";
import type { AgentMessage } from "../src/pi-types.js";
import type { CarrierAssociation, CarrierDecisionV1 } from "../src/types.js";
import { anchor, assistant, toolResult, user } from "./helpers.js";

describe("context transform", () => {
	it("converts string user content only on the outbound copy", () => {
		const original = user(1, "prompt");
		const snapshot = structuredClone(original);
		const transformed = prependStamp(original, "sent_at: 2026-08-22 14:15");
		expect(original).toEqual(snapshot);
		expect(transformed).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "sent_at: 2026-08-22 14:15" },
				{ type: "text", text: "prompt" },
			],
		});
	});

	it("preserves tool result content and protocol fields", () => {
		const original = toolResult(1, "call-1", "large result");
		const transformed = prependStamp(original, "sent_at: 1970-01-01 00:00");
		expect(transformed).toMatchObject({
			role: "toolResult",
			toolCallId: "call-1",
			isError: false,
			content: [
				{ type: "text", text: "sent_at: 1970-01-01 00:00" },
				{ type: "text", text: "large result" },
			],
		});
	});

	it("replays the same decision byte-for-byte", () => {
		const message = user(1);
		const association: CarrierAssociation = {
			messageIndex: 0,
			entryId: "u1",
			kind: "user",
			message,
		};
		const decision: CarrierDecisionV1 = {
			version: 1,
			carrierEntryId: "u1",
			carrierKind: "user",
			firstSentAtMs: 0,
			checkpointIndex: 0,
			stamp: { renderVersion: 1 },
		};
		const decisions = new Map([["u1", decision]]);
		const first = transformContextMessages([message], [association], decisions, anchor());
		const second = transformContextMessages([message], [association], decisions, anchor());
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		if (message.role !== "user") throw new Error("Expected user message");
		expect(message.content).toBe("hello");
	});

	it("stamps the compaction summary with the session start time", () => {
		const summary: AgentMessage = {
			role: "compactionSummary",
			summary: "Earlier conversation summary",
			tokensBefore: 1000,
			timestamp: 5 * 60_000,
		};
		const transformed = transformContextMessages([summary], [], new Map(), anchor(0));
		if (transformed[0]?.role !== "compactionSummary") throw new Error("Expected compaction summary");
		expect(transformed[0].summary).toBe(
			"session_started_at: 1970-01-01 00:00 +00:00\n\nEarlier conversation summary",
		);
		expect(summary.summary).toBe("Earlier conversation summary");
	});

	it("leaves messages untouched when the context does not start with a compaction summary", () => {
		const messages = [user(0), assistant(1)];
		const transformed = transformContextMessages(messages, [], new Map(), anchor(0));
		expect(transformed).toEqual(messages);
	});
});
