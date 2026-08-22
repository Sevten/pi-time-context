import { describe, expect, it } from "vitest";
import { appendStamp, transformContextMessages } from "../src/context-transform.js";
import type { CarrierAssociation, CarrierDecisionV1 } from "../src/types.js";
import { anchor, toolResult, user } from "./helpers.js";

describe("context transform", () => {
	it("converts string user content only on the outbound copy", () => {
		const original = user(1, "prompt");
		const snapshot = structuredClone(original);
		const transformed = appendStamp(original, "sent_at: 2026-08-22 14:15");
		expect(original).toEqual(snapshot);
		expect(transformed).toMatchObject({
			role: "user",
			content: [
				{ type: "text", text: "prompt" },
				{ type: "text", text: "sent_at: 2026-08-22 14:15" },
			],
		});
	});

	it("preserves tool result content and protocol fields", () => {
		const original = toolResult(1, "call-1", "large result");
		const transformed = appendStamp(original, "sent_at: 1970-01-01 00:00");
		expect(transformed).toMatchObject({
			role: "toolResult",
			toolCallId: "call-1",
			isError: false,
			content: [
				{ type: "text", text: "large result" },
				{ type: "text", text: "sent_at: 1970-01-01 00:00" },
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
		const first = transformContextMessages([message], [association], decisions, anchor().policy);
		const second = transformContextMessages([message], [association], decisions, anchor().policy);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		if (message.role !== "user") throw new Error("Expected user message");
		expect(message.content).toBe("hello");
	});
});
