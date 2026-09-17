import { describe, expect, it } from "vitest";
import { decisionModelText } from "../src/visibility.js";
import type { CarrierDecisionV1, CarrierStampV1 } from "../src/types.js";

const TZ = "Asia/Shanghai";

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

describe("decisionModelText", () => {
	it("returns undefined for unstamped decisions", () => {
		expect(decisionModelText(decision(null), () => TZ)).toBeUndefined();
	});

	it("renders the exact annotation the model receives", () => {
		// 1970-01-01 00:00 UTC = 08:00 +08:00; 135 minutes = 2h15m
		const text = decisionModelText(
			decision({ previousActivityKey: "assistant:a", elapsedMinutes: 135 }),
			() => TZ,
		);
		expect(text).toBe("⟦TIME event=user_message_sent at=1970-01-01T08:00+08:00 idle=2h15m⟧");
	});

	it("omits the idle segment when absent", () => {
		const text = decisionModelText(decision({}), () => TZ);
		expect(text).toBe("⟦TIME event=user_message_sent at=1970-01-01T08:00+08:00⟧");
	});

	it("never renders idle on tool results, matching the model context", () => {
		const toolResult: CarrierDecisionV1 = { ...decision({ elapsedMinutes: 135 }), carrierKind: "tool_result" };
		const text = decisionModelText(toolResult, () => TZ);
		expect(text).toBe("⟦TIME event=tool_result_returned at=1970-01-01T08:00+08:00⟧");
	});

	it("falls back to the local time zone when no policy resolves", () => {
		const text = decisionModelText(decision({}), () => undefined);
		expect(text).toMatch(/^⟦TIME event=user_message_sent at=1970-01-01T\d{2}:\d{2}[+-]\d{2}:\d{2}⟧$/);
	});
});
