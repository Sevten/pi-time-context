import { describe, expect, it } from "vitest";
import { decisionDisplayText } from "../src/visibility.js";
import type { CarrierDecisionV1, CarrierStampV1 } from "../src/types.js";

function decision(stamp: CarrierStampV1 | null, firstSentAtMs = 0): CarrierDecisionV1 {
	return {
		version: 1 as const,
		carrierEntryId: "carrier",
		carrierKind: "user" as const,
		firstSentAtMs,
		checkpointIndex: 0,
		stamp,
	};
}

describe("decisionDisplayText", () => {
	it("returns undefined for unstamped decisions", () => {
		expect(decisionDisplayText(decision(null))).toBeUndefined();
	});

	it("renders the local timestamp and elapsed time", () => {
		const text = decisionDisplayText(
			decision({ renderVersion: 1, previousActivityKey: "assistant:a", elapsedMinutes: 135 }, 0),
		)!;
		expect(text).toContain("sent_at");
		expect(text).toContain("2小时15分钟");
	});

	it("omits the elapsed segment when absent", () => {
		const text = decisionDisplayText(decision({ renderVersion: 1 }))??"";
		expect(text).toContain("sent_at");
		expect(text).not.toContain("距上次活动");
	});
});
