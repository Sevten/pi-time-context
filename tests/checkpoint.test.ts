import { describe, expect, it } from "vitest";
import { createCarrierDecision } from "../src/checkpoint.js";
import { anchor } from "./helpers.js";

const INTERVAL = 30 * 60_000;

function decide(firstSentAtMs: number, lastStampedCheckpointIndex = 0) {
	return createCarrierDecision({
		carrierEntryId: "carrier",
		carrierKind: "user",
		firstSentAtMs,
		t0Ms: 0,
			policy: anchor(0).policy,
		lastStampedCheckpointIndex,
		isBaseline: false,
	});
}

describe("checkpoint decisions", () => {
	it("always stamps the first user baseline in bucket zero", () => {
		const result = createCarrierDecision({
			carrierEntryId: "first",
			carrierKind: "user",
			firstSentAtMs: 0,
			t0Ms: 0,
			policy: anchor(0).policy,
			lastStampedCheckpointIndex: 0,
			isBaseline: true,
		});
		expect(result.decision.checkpointIndex).toBe(0);
		expect(result.decision.stamp).toEqual({ renderVersion: 1 });
	});

	it("uses exact anchored interval boundaries", () => {
		expect(decide(INTERVAL - 1).decision.stamp).toBeNull();
		expect(decide(INTERVAL).decision.stamp).not.toBeNull();
		expect(decide(INTERVAL + 1, 1).decision.stamp).toBeNull();
	});

	it("skips directly to the current checkpoint bucket", () => {
		const result = decide(8 * INTERVAL);
		expect(result.decision.checkpointIndex).toBe(8);
		expect(result.decision.stamp).not.toBeNull();
	});

	it("requires a gap strictly greater than the threshold", () => {
		const exact = createCarrierDecision({
			carrierEntryId: "exact",
			carrierKind: "user",
			firstSentAtMs: INTERVAL,
			t0Ms: 0,
			policy: anchor(0).policy,
			lastStampedCheckpointIndex: 0,
			isBaseline: false,
			previousActivity: { key: "assistant:a", completedAtMs: 0 },
		});
		const over = createCarrierDecision({
			carrierEntryId: "over",
			carrierKind: "user",
			firstSentAtMs: INTERVAL + 1,
			t0Ms: 0,
			policy: anchor(0).policy,
			lastStampedCheckpointIndex: 0,
			isBaseline: false,
			previousActivity: { key: "assistant:a", completedAtMs: 0 },
		});
		expect(exact.decision.stamp).toEqual({ renderVersion: 1 });
		expect(over.decision.stamp).toEqual({
			renderVersion: 1,
			previousActivityKey: "assistant:a",
			elapsedMinutes: 30,
		});
	});

	it("omits a negative elapsed gap and records a clock anomaly", () => {
		const result = createCarrierDecision({
			carrierEntryId: "backwards",
			carrierKind: "user",
			firstSentAtMs: INTERVAL,
			t0Ms: 0,
			policy: anchor(0).policy,
			lastStampedCheckpointIndex: 0,
			isBaseline: false,
			previousActivity: { key: "assistant:future", completedAtMs: INTERVAL + 1 },
		});
		expect(result.clockAnomaly).toBe("backwards");
		expect(result.decision.stamp).toEqual({ renderVersion: 1 });
	});
});

describe("every-message mode", () => {
	function everyAnchor() {
		const base = anchor(0);
		return { ...base, policy: { ...base.policy, stampEveryMessage: true } };
	}

	function decideEvery(firstSentAtMs: number, lastStampedCheckpointIndex = 0) {
		const base = everyAnchor();
		return createCarrierDecision({
			carrierEntryId: "carrier",
			carrierKind: "user",
			firstSentAtMs,
			t0Ms: base.t0Ms,
			policy: base.policy,
			lastStampedCheckpointIndex,
			isBaseline: false,
		});
	}

	it("stamps every carrier regardless of bucket boundaries", () => {
		expect(decideEvery(1).decision.stamp).not.toBeNull();
		expect(decideEvery(INTERVAL / 2).decision.stamp).not.toBeNull();
		expect(decideEvery(3 * INTERVAL, 3).decision.stamp).not.toBeNull();
	});

	it("still records the checkpoint index for later interval mode", () => {
		expect(decideEvery(8 * INTERVAL).decision.checkpointIndex).toBe(8);
	});

	it("stamp includes elapsed time like interval mode", () => {
		const base = everyAnchor();
		const result = createCarrierDecision({
			carrierEntryId: "carrier",
			carrierKind: "user",
			firstSentAtMs: INTERVAL + 1,
			t0Ms: 0,
			policy: base.policy,
			lastStampedCheckpointIndex: 0,
			isBaseline: false,
			previousActivity: { key: "assistant:a", completedAtMs: 0 },
		});
		expect(result.decision.stamp).toEqual({
			renderVersion: 1,
			previousActivityKey: "assistant:a",
			elapsedMinutes: 30,
		});
	});
});
