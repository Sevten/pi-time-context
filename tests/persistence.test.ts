import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyForkMetadata } from "../src/fork-copy.js";
import { parseCarrierDecision, parseSessionAnchor } from "../src/persistence.js";
import { recoverState } from "../src/state.js";
import {
	ACTIVITY_FACTS_ENTRY,
	CARRIER_DECISION_ENTRY,
	SESSION_ANCHOR_ENTRY,
	type ActivityFactsV1,
	type CarrierDecisionV1,
} from "../src/types.js";
import { anchor, customEntry, messageEntry, user } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

function decision(carrierEntryId: string, firstSentAtMs: number): CarrierDecisionV1 {
	return {
		version: 1,
		carrierEntryId,
		carrierKind: "user",
		firstSentAtMs,
		checkpointIndex: 0,
		stamp: { renderVersion: 1 },
	};
}

describe("persistence", () => {
	it("filters metadata by the active branch and keeps the earliest duplicate decision", () => {
		const u1 = messageEntry("u1", null, user(1));
		const u2 = messageEntry("u2", "u1", user(2));
		const facts: ActivityFactsV1 = {
			version: 1,
			activities: [
				{ key: "user:u1", kind: "user", messageEntryId: "u1", processedAtMs: 10 },
				{ key: "user:u2", kind: "user", messageEntryId: "u2", processedAtMs: 20 },
			],
		};
		const entries = [
			u1,
			u2,
			customEntry("anchor", "u2", SESSION_ANCHOR_ENTRY, anchor()),
			customEntry("facts", "anchor", ACTIVITY_FACTS_ENTRY, facts),
			customEntry("d1", "facts", CARRIER_DECISION_ENTRY, decision("u1", 10)),
			customEntry("d2", "d1", CARRIER_DECISION_ENTRY, decision("u1", 20)),
			customEntry("d3", "d2", CARRIER_DECISION_ENTRY, decision("u2", 30)),
		];
		const state = recoverState(entries, [u1]);
		expect([...state.activitiesByKey.keys()]).toEqual(["user:u1"]);
		expect(state.decisionsByCarrierId.get("u1")?.firstSentAtMs).toBe(10);
		expect(state.decisionsByCarrierId.has("u2")).toBe(false);
	});

	it("ignores malformed and unknown versions without throwing", () => {
		const warnings: string[] = [];
		expect(parseSessionAnchor({ version: 2 }, (message) => warnings.push(message))).toBeUndefined();
		expect(
			parseCarrierDecision({ version: 1, carrierEntryId: 3 }, (message) => warnings.push(message)),
		).toBeUndefined();
		expect(warnings).toHaveLength(2);
	});

	it("copies missing fork-tail metadata only for retained message IDs", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-time-context-fork-"));
		temporaryDirectories.push(directory);
		const source = join(directory, "source.jsonl");
		const sourceFacts: ActivityFactsV1 = {
			version: 1,
			activities: [
				{ key: "user:u1", kind: "user", messageEntryId: "u1", processedAtMs: 10 },
				{ key: "user:dropped", kind: "user", messageEntryId: "dropped", processedAtMs: 20 },
			],
		};
		const lines = [
			{ type: "session", id: "source" },
			{ type: "custom", customType: SESSION_ANCHOR_ENTRY, data: anchor() },
			{ type: "custom", customType: ACTIVITY_FACTS_ENTRY, data: sourceFacts },
			{ type: "custom", customType: CARRIER_DECISION_ENTRY, data: decision("u1", 10) },
			{ type: "custom", customType: CARRIER_DECISION_ENTRY, data: decision("dropped", 20) },
		];
		await writeFile(source, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
		const retained = messageEntry("u1", null, user(1));
		const appended: Array<{ customType: string; data: unknown }> = [];
		await copyForkMetadata({
			previousSessionFile: source,
			currentEntries: [retained],
			currentBranch: [retained],
			append: (customType, data) => appended.push({ customType, data }),
		});

		expect(appended.map((item) => item.customType)).toEqual([
			SESSION_ANCHOR_ENTRY,
			ACTIVITY_FACTS_ENTRY,
			CARRIER_DECISION_ENTRY,
		]);
		expect(appended[1]?.data).toEqual({
			version: 1,
			activities: [{ key: "user:u1", kind: "user", messageEntryId: "u1", processedAtMs: 10 }],
		});
	});
});
