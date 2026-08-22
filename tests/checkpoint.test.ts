import { describe, expect, it } from "vitest";
import { createCarrierDecision } from "../src/checkpoint.js";
import { anchor } from "./helpers.js";

const INTERVAL = 30 * 60_000;

function decide(firstSentAtMs: number, lastStampedCheckpointIndex = 0) {
	return createCarrierDecision({
		carrierEntryId: "carrier",
		carrierKind: "user",
		firstSentAtMs,
		anchor: anchor(0),
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
			anchor: anchor(0),
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
			anchor: anchor(0),
			lastStampedCheckpointIndex: 0,
			isBaseline: false,
			previousActivity: { key: "assistant:a", completedAtMs: 0 },
		});
		const over = createCarrierDecision({
			carrierEntryId: "over",
			carrierKind: "user",
			firstSentAtMs: INTERVAL + 1,
			anchor: anchor(0),
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
			anchor: anchor(0),
			lastStampedCheckpointIndex: 0,
			isBaseline: false,
			previousActivity: { key: "assistant:future", completedAtMs: INTERVAL + 1 },
		});
		expect(result.clockAnomaly).toBe("backwards");
		expect(result.decision.stamp).toEqual({ renderVersion: 1 });
	});
});
