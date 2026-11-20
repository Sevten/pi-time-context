import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { copyForkMetadata } from "../src/fork-copy.js";
import {
	ACTIVITY_FACTS_ENTRY,
	CARRIER_DECISION_ENTRY,
	SESSION_ANCHOR_ENTRY,
	type ActivityV1,
	type CarrierDecisionV1,
	type SessionAnchorV1,
} from "../src/types.js";
import { anchor, customEntry, messageEntry, user } from "./helpers.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

function writeSessionFile(records: { customType: string; data: unknown }[]): string {
	const dir = mkdtempSync(join(tmpdir(), "fork-copy-"));
	const path = join(dir, "previous.jsonl");
	const lines = records.map((record) => JSON.stringify({ type: "custom", ...record }));
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

function userActivity(key: string, messageEntryId: string, processedAtMs = 1_000): ActivityV1 {
	return { key, kind: "user", messageEntryId, processedAtMs };
}

function toolActivity(key: string, toolCallId: string, toolResultEntryId?: string): ActivityV1 {
	return {
		key,
		kind: "tool",
		toolCallId,
		toolResultEntryId,
		startedAtMs: 1_000,
		completedAtMs: 2_000,
		isError: false,
	};
}

function decision(carrierEntryId: string): CarrierDecisionV1 {
	return {
		version: 1,
		carrierEntryId,
		carrierKind: "user",
		firstSentAtMs: 1_000,
		checkpointIndex: 0,
		stamp: null,
	};
}

async function run(
	previousRecords: { customType: string; data: unknown }[],
	currentEntries: readonly SessionEntry[],
	branch: readonly SessionEntry[] = currentEntries,
): Promise<{ customType: string; data: unknown }[]> {
	const appended: { customType: string; data: unknown }[] = [];
	const warnings: string[] = [];
	await copyForkMetadata({
		previousSessionFile: writeSessionFile(previousRecords),
		currentEntries,
		currentBranch: branch,
		append: (customType, data) => appended.push({ customType, data }),
		warn: (message) => warnings.push(message),
	});
	expect(warnings).toEqual([]);
	return appended;
}

describe("copyForkMetadata — session anchor", () => {
	it("copies the anchor when the current session has none", async () => {
		const sourceAnchor: SessionAnchorV1 = { ...anchor(123), origin: "first_user_processed" };
		const appended = await run(
			[{ customType: SESSION_ANCHOR_ENTRY, data: sourceAnchor }],
			[messageEntry("m1", null, user(1_000))],
		);
		expect(appended).toEqual([{ customType: SESSION_ANCHOR_ENTRY, data: sourceAnchor }]);
	});

	it("does not copy an anchor when the current session already has one", async () => {
		const currentAnchor = anchor(456);
		const appended = await run(
			[{ customType: SESSION_ANCHOR_ENTRY, data: { ...anchor(123) } }],
			[
				customEntry("a1", null, SESSION_ANCHOR_ENTRY, currentAnchor),
				messageEntry("m1", "a1", user(1_000)),
			],
		);
		expect(appended).toEqual([]);
	});

	it("does nothing when neither side has an anchor", async () => {
		const appended = await run([], [messageEntry("m1", null, user(1_000))]);
		expect(appended).toEqual([]);
	});
});

describe("copyForkMetadata — activities", () => {
	it("copies activities whose carrier entries are on the current branch", async () => {
		const activity = userActivity("k1", "m1");
		const appended = await run(
			[{ customType: ACTIVITY_FACTS_ENTRY, data: { version: 1, activities: [activity] } }],
			[messageEntry("m1", null, user(1_000))],
		);
		expect(appended).toEqual([
			{ customType: ACTIVITY_FACTS_ENTRY, data: { version: 1, activities: [activity] } },
		]);
	});

	it("skips activities already present in the current session (matched by key)", async () => {
		const activity = userActivity("k1", "m1");
		const appended = await run(
			[{ customType: ACTIVITY_FACTS_ENTRY, data: { version: 1, activities: [activity] } }],
			[
				customEntry("a1", null, ACTIVITY_FACTS_ENTRY, { version: 1, activities: [activity] }),
				messageEntry("m1", "a1", user(1_000)),
			],
		);
		expect(appended).toEqual([]);
	});

	it("skips activities whose carrier entries are off-branch", async () => {
		const appended = await run(
			[
				{
					customType: ACTIVITY_FACTS_ENTRY,
					data: { version: 1, activities: [userActivity("k1", "m-other")] },
				},
			],
			[messageEntry("m1", null, user(1_000))],
		);
		expect(appended).toEqual([]);
	});

	it("copies tool activities keyed on the tool result entry", async () => {
		const activity = toolActivity("t1", "call-1", "tr1");
		const appended = await run(
			[{ customType: ACTIVITY_FACTS_ENTRY, data: { version: 1, activities: [activity] } }],
			[
				messageEntry("m1", null, user(1_000)),
				{
					type: "message",
					id: "tr1",
					parentId: "m1",
					timestamp: new Date(0).toISOString(),
					message: {
						role: "toolResult",
						toolCallId: "call-1",
						toolName: "test",
						content: [{ type: "text", text: "ok" }],
						isError: false,
						timestamp: 2_000,
					},
				},
			],
		);
		expect(appended).toEqual([
			{ customType: ACTIVITY_FACTS_ENTRY, data: { version: 1, activities: [activity] } },
		]);
	});

	it("skips tool activities without their tool result on the branch", async () => {
		const appended = await run(
			[{ customType: ACTIVITY_FACTS_ENTRY, data: { version: 1, activities: [toolActivity("t1", "call-1", "tr1")] } }],
			[messageEntry("m1", null, user(1_000))],
		);
		expect(appended).toEqual([]);
	});

	it("deduplicates multiple source activities with the same key", async () => {
		const activity = userActivity("k1", "m1");
		const appended = await run(
			[
				{ customType: ACTIVITY_FACTS_ENTRY, data: { version: 1, activities: [activity] } },
				{ customType: ACTIVITY_FACTS_ENTRY, data: { version: 1, activities: [activity] } },
			],
			[messageEntry("m1", null, user(1_000))],
		);
		expect(appended).toEqual([
			{ customType: ACTIVITY_FACTS_ENTRY, data: { version: 1, activities: [activity] } },
		]);
	});
});

describe("copyForkMetadata — carrier decisions", () => {
	it("copies decisions whose carrier entry is on the branch", async () => {
		const d = decision("m1");
		const appended = await run(
			[{ customType: CARRIER_DECISION_ENTRY, data: d }],
			[messageEntry("m1", null, user(1_000))],
		);
		expect(appended).toEqual([{ customType: CARRIER_DECISION_ENTRY, data: d }]);
	});

	it("skips decisions already present in the current session", async () => {
		const d = decision("m1");
		const appended = await run(
			[{ customType: CARRIER_DECISION_ENTRY, data: d }],
			[
				customEntry("a1", null, CARRIER_DECISION_ENTRY, d),
				messageEntry("m1", "a1", user(1_000)),
			],
		);
		expect(appended).toEqual([]);
	});

	it("skips decisions for off-branch carriers", async () => {
		const appended = await run(
			[{ customType: CARRIER_DECISION_ENTRY, data: decision("m-other") }],
			[messageEntry("m1", null, user(1_000))],
		);
		expect(appended).toEqual([]);
	});
});

describe("copyForkMetadata — robustness", () => {
	it("ignores malformed records in the previous session file without warnings", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fork-copy-"));
		const path = join(dir, "previous.jsonl");
		const good = JSON.stringify({ type: "custom", customType: SESSION_ANCHOR_ENTRY, data: anchor(123) });
		writeFileSync(path, `${good}\n{ not json\n`);
		const appended: { customType: string; data: unknown }[] = [];
		await copyForkMetadata({
			previousSessionFile: path,
			currentEntries: [messageEntry("m1", null, user(1_000))],
			currentBranch: [messageEntry("m1", null, user(1_000))],
			append: (customType, data) => appended.push({ customType, data }),
		});
		expect(appended).toEqual([{ customType: SESSION_ANCHOR_ENTRY, data: anchor(123) }]);
	});

	it("tolerates a missing previous session file", async () => {
		const appended: { customType: string; data: unknown }[] = [];
		const warnings: string[] = [];
		await copyForkMetadata({
			previousSessionFile: join(tmpdir(), "fork-copy-does-not-exist.jsonl"),
			currentEntries: [messageEntry("m1", null, user(1_000))],
			currentBranch: [messageEntry("m1", null, user(1_000))],
			append: (customType, data) => appended.push({ customType, data }),
			warn: (message) => warnings.push(message),
		});
		expect(appended).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("Unable to read previous session metadata");
	});

	it("copies anchor, activities, and decisions together in one pass", async () => {
		const sourceAnchor = anchor(123);
		const activity = userActivity("k1", "m1");
		const d = decision("m1");
		const appended = await run(
			[
				{ customType: SESSION_ANCHOR_ENTRY, data: sourceAnchor },
				{ customType: ACTIVITY_FACTS_ENTRY, data: { version: 1, activities: [activity] } },
				{ customType: CARRIER_DECISION_ENTRY, data: d },
			],
			[messageEntry("m1", null, user(1_000))],
		);
		expect(appended.map((record) => record.customType)).toEqual([
			SESSION_ANCHOR_ENTRY,
			ACTIVITY_FACTS_ENTRY,
			CARRIER_DECISION_ENTRY,
		]);
	});
});
