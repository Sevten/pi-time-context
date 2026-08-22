import { describe, expect, it } from "vitest";
import { formatElapsedMinutes, renderDecision } from "../src/renderer.js";
import type { CarrierDecisionV1 } from "../src/types.js";
import { anchor } from "./helpers.js";

describe("renderer", () => {
	it("uses stable field order and minute precision", () => {
		const decision: CarrierDecisionV1 = {
			version: 1,
			carrierEntryId: "u1",
			carrierKind: "user",
			firstSentAtMs: Date.UTC(2026, 7, 22, 6, 15, 59),
			checkpointIndex: 1,
			stamp: { renderVersion: 1, elapsedMinutes: 135 },
		};
		expect(renderDecision(decision, { ...anchor().policy, timeZone: "Asia/Shanghai" })).toBe(
			"sent_at: 2026-08-22 14:15 +08:00\nelapsed_since_last_activity: 2小时15分钟",
		);
	});

	it("renders elapsed values without redundant components", () => {
		expect(formatElapsedMinutes(35)).toBe("35分钟");
		expect(formatElapsedMinutes(120)).toBe("2小时");
		expect(formatElapsedMinutes(135)).toBe("2小时15分钟");
	});

	it("renders no text for a null decision", () => {
		const decision: CarrierDecisionV1 = {
			version: 1,
			carrierEntryId: "u1",
			carrierKind: "user",
			firstSentAtMs: 0,
			checkpointIndex: 0,
			stamp: null,
		};
		expect(renderDecision(decision, anchor().policy)).toBeUndefined();
	});
});
