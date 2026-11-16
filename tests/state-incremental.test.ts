import { describe, expect, it } from "vitest";
import {
	ACTIVITY_FACTS_ENTRY,
	CARRIER_DECISION_ENTRY,
	SESSION_ANCHOR_ENTRY,
	type ActivityFactsV1,
	type CarrierDecisionV1,
	type SessionAnchorV1,
} from "../src/types.js";
import { extendRecoveredState, recoverState } from "../src/state.js";
import { anchor, customEntry, messageEntry, user } from "./helpers.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

const base = anchor();

function fixtureEntries(): SessionEntry[] {
	const u1 = messageEntry("u1", null, user(1000, "first"));
	const a1: SessionEntry = customEntry("c1", "u1", SESSION_ANCHOR_ENTRY, base);
	const u2 = messageEntry("u2", "c1", user(2000, "second"));
	const d1: SessionEntry = customEntry("c2", "u2", CARRIER_DECISION_ENTRY, {
		version: 1,
		carrierEntryId: "u1",
		carrierKind: "user",
		firstSentAtMs: 1000,
		checkpointIndex: 0,
		stamp: {},
	} satisfies CarrierDecisionV1);
	const f1: SessionEntry = customEntry(
		"c3",
		"c2",
		ACTIVITY_FACTS_ENTRY,
		{
			version: 1,
			activities: [{ key: "user:u1", kind: "user", messageEntryId: "u1", processedAtMs: 1000 }],
		} satisfies ActivityFactsV1,
	);
	const d2: SessionEntry = customEntry("c4", "c3", CARRIER_DECISION_ENTRY, {
		version: 1,
		carrierEntryId: "u2",
		carrierKind: "user",
		firstSentAtMs: 3600_000,
		checkpointIndex: 1,
		stamp: null,
	} satisfies CarrierDecisionV1);
	return [u1, a1, u2, d1, f1, d2];
}

describe("extendRecoveredState", () => {
	const prefix = fixtureEntries().slice(0, 3);
	const full = fixtureEntries();

	it("matches a from-scratch recovery when folding an appended tail", () => {
		const incremental = extendRecoveredState(recoverState(prefix, prefix), full, prefix.length, full);
		expect(incremental).toEqual(recoverState(full, full));
	});

	it("keeps anchor, decisions, activities, and last stamped index across folds", () => {
		let state = recoverState(prefix.slice(0, 1), prefix.slice(0, 1));
		state = extendRecoveredState(state, prefix, 1, prefix);
		expect(state.anchor).toEqual(base);
		state = extendRecoveredState(state, full, prefix.length, full);
		expect(state.anchor).toEqual(base);
		expect(state.decisionsByCarrierId.get("u1")?.stamp).toEqual({});
		expect(state.decisionsByCarrierId.get("u2")?.stamp).toBeNull();
		expect(state.activitiesByKey.get("user:u1")).toMatchObject({ processedAtMs: 1000 });
		expect(state.lastStampedCheckpointIndex).toBe(0);
	});

	it("ignores an appended anchor when one is already recovered", () => {
		const secondAnchor: SessionEntry = customEntry("c5", "c4", SESSION_ANCHOR_ENTRY, {
			...base,
			t0Ms: 999,
		} satisfies SessionAnchorV1);
		const withSecond: SessionEntry[] = [...full, secondAnchor];
		const incremental = extendRecoveredState(recoverState(full, full), withSecond, full.length, withSecond);
		expect(incremental.anchor?.t0Ms).toBe(base.t0Ms);
	});
});
