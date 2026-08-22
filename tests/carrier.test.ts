import { describe, expect, it } from "vitest";
import {
	associateCarrierMessages,
	findPreviousCompletedActivity,
	findTailCarrierGroup,
	selectCarrier,
} from "../src/carrier.js";
import type { ActivityV1 } from "../src/types.js";
import { assistantWithTools, messageEntry, toolResult, user } from "./helpers.js";

describe("carrier selection", () => {
	it("associates outbound messages with persistent entry IDs", () => {
		const first = user(10, "same");
		const second = user(10, "same");
		const branch = [messageEntry("u1", null, first), messageEntry("u2", "u1", second)];
		const associations = associateCarrierMessages([first, second], branch);
		expect(associations.map((item) => item.entryId)).toEqual(["u1", "u2"]);
	});

	it("selects the actually last-completed parallel tool, not array order", () => {
		const assistant = assistantWithTools(1, ["a", "b"]);
		const resultA = toolResult(2, "a");
		const resultB = toolResult(3, "b");
		const branch = [
			messageEntry("assistant", null, assistant),
			messageEntry("result-a", "assistant", resultA),
			messageEntry("result-b", "result-a", resultB),
		];
		const messages = [assistant, resultA, resultB];
		const associations = associateCarrierMessages(messages, branch);
		const group = findTailCarrierGroup(messages, associations);
		const activities = new Map<string, ActivityV1>([
			[
				"tool:a",
				{
					key: "tool:a",
					kind: "tool",
					toolCallId: "a",
					toolResultEntryId: "result-a",
					startedAtMs: 10,
					completedAtMs: 200,
					isError: false,
				},
			],
			[
				"tool:b",
				{
					key: "tool:b",
					kind: "tool",
					toolCallId: "b",
					toolResultEntryId: "result-b",
					startedAtMs: 20,
					completedAtMs: 150,
					isError: false,
				},
			],
		]);
		const selected = selectCarrier(group, activities);
		expect(selected?.toolCallId).toBe("a");
		expect(findPreviousCompletedActivity(selected!, activities)).toEqual({
			key: "tool:b",
			completedAtMs: 150,
		});
	});

	it("does not select a historical carrier when context ends in assistant", () => {
		const prompt = user(1);
		const response = assistantWithTools(2, []);
		const branch = [messageEntry("u", null, prompt), messageEntry("a", "u", response)];
		const messages = [prompt, response];
		const associations = associateCarrierMessages(messages, branch);
		expect(findTailCarrierGroup(messages, associations)).toEqual([]);
	});
});
