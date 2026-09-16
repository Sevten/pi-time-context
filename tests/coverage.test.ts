import { describe, expect, it } from "vitest";
import { computeCoverageUntilMs } from "../src/state.js";
import type { ActivityFactsV1, ActivityV1 } from "../src/types.js";
import { assistant, messageEntry, toolResult, user } from "./helpers.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function compactionEntry(id: string, parentId: string, firstKeptEntryId: string): SessionEntry {
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		summary: "summary",
		firstKeptEntryId,
		tokensBefore: 100,
	};
}

function activities(items: ActivityV1[]): Map<string, ActivityV1> {
	const facts: ActivityFactsV1 = { version: 1, activities: items };
	return new Map(facts.activities.map((activity) => [activity.key, activity]));
}

describe("computeCoverageUntilMs", () => {
	it("returns undefined when the branch has no compaction", () => {
		const branch = [messageEntry("u1", null, user(1))];
		expect(computeCoverageUntilMs(branch, activities([]))).toBeUndefined();
	});

	it("takes the latest completed activity among entries covered by the latest compaction", () => {
		const u1 = messageEntry("u1", null, user(1));
		const a1 = messageEntry("a1", "u1", assistant(2));
		const r1 = messageEntry("r1", "a1", toolResult(3, "call-1"));
		const u2 = messageEntry("u2", "r1", user(4));
		const compaction = compactionEntry("c1", u2.id, u2.id);
		const branch = [u1, a1, r1, u2, compaction];
		const acts = activities([
			{ key: "user:u1", kind: "user", messageEntryId: "u1", processedAtMs: 10 },
			{ key: "assistant:a1", kind: "assistant", messageEntryId: "a1", completedAtMs: 20 },
			{
				key: "tool:call-1",
				kind: "tool",
				toolCallId: "call-1",
				toolResultEntryId: "r1",
				startedAtMs: 21,
				completedAtMs: 30,
				isError: false,
			},
			// u2 survives the compaction: its activity must not count.
			{ key: "user:u2", kind: "user", messageEntryId: "u2", processedAtMs: 99 },
		]);
		expect(computeCoverageUntilMs(branch, acts)).toBe(30);
	});

	it("follows a second compaction and shrinks the covered span", () => {
		const u1 = messageEntry("u1", null, user(1));
		const u2 = messageEntry("u2", "placeholder", user(4));
		const compaction1 = compactionEntry("c1", u1.id, u2.id);
		const compaction2 = compactionEntry("c2", u2.id, "u3");
		const u3 = messageEntry("u3", compaction2.id, user(5));
		const branch = [u1, compaction1, u2, compaction2, u3];
		const acts = activities([
			{ key: "user:u1", kind: "user", messageEntryId: "u1", processedAtMs: 10 },
			{ key: "user:u2", kind: "user", messageEntryId: "u2", processedAtMs: 40 },
		]);
		expect(computeCoverageUntilMs(branch, acts)).toBe(40);
	});

	it("returns undefined when no activity maps to a covered entry", () => {
		const u1 = messageEntry("u1", null, user(1));
		const branch = [u1, compactionEntry("c1", u1.id, "u1")];
		expect(computeCoverageUntilMs(branch, activities([]))).toBeUndefined();
	});
});
