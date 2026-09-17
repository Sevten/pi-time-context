import { describe, expect, it } from "vitest";
import { computeUiStampAssociations } from "../src/state.js";
import { UI_STAMP_ENTRY } from "../src/types.js";
import { assistant, customEntry, messageEntry, toolResult, user } from "./helpers.js";

function branchOf(...entries: unknown[]) {
	return entries as Parameters<typeof computeUiStampAssociations>[0];
}

describe("computeUiStampAssociations", () => {
	it("maps a stamp to the following user message entry", () => {
		const branch = branchOf(
			customEntry("s1", null, UI_STAMP_ENTRY, { version: 1, sentAtMs: 0 }),
			messageEntry("u1", "s1", user(1)),
		);
		const { stampToCarrier, carriersWithStamp } = computeUiStampAssociations(branch);
		expect(stampToCarrier.get("s1")).toBe("u1");
		expect(carriersWithStamp.has("u1")).toBe(true);
	});

	it("skips intervening custom entries between a stamp and its message", () => {
		const branch = branchOf(
			customEntry("s1", null, UI_STAMP_ENTRY, { version: 1, sentAtMs: 0 }),
			customEntry("anchor", "s1", "pi-time-context/session-anchor", { version: 1 }),
			messageEntry("u1", "anchor", user(1)),
		);
		const { stampToCarrier } = computeUiStampAssociations(branch);
		expect(stampToCarrier.get("s1")).toBe("u1");
	});

	it("orphans stamps followed by an assistant or tool-result message", () => {
		const branch = branchOf(
			customEntry("s1", null, UI_STAMP_ENTRY, { version: 1, sentAtMs: 0 }),
			messageEntry("a1", "s1", assistant(2)),
			customEntry("s2", "a1", UI_STAMP_ENTRY, { version: 1, sentAtMs: 3 }),
			messageEntry("r1", "s2", toolResult(4, "tc1")),
		);
		const { stampToCarrier, carriersWithStamp } = computeUiStampAssociations(branch);
		expect(stampToCarrier.size).toBe(0);
		expect(carriersWithStamp.size).toBe(0);
	});

	it("keeps only the stamp closest to the message when several pile up", () => {
		const branch = branchOf(
			customEntry("s1", null, UI_STAMP_ENTRY, { version: 1, sentAtMs: 0 }),
			customEntry("s2", "s1", UI_STAMP_ENTRY, { version: 1, sentAtMs: 1 }),
			messageEntry("u1", "s2", user(2)),
		);
		const { stampToCarrier, carriersWithStamp } = computeUiStampAssociations(branch);
		expect(stampToCarrier.get("s1")).toBeUndefined();
		expect(stampToCarrier.get("s2")).toBe("u1");
		expect(carriersWithStamp.has("u1")).toBe(true);
	});

	it("only the last pending stamp survives across consecutive user messages", () => {
		const branch = branchOf(
			customEntry("s1", null, UI_STAMP_ENTRY, { version: 1, sentAtMs: 0 }),
			customEntry("s2", "s1", UI_STAMP_ENTRY, { version: 1, sentAtMs: 1 }),
			messageEntry("u1", "s2", user(2)),
			messageEntry("u2", "u1", user(3)),
		);
		const { stampToCarrier } = computeUiStampAssociations(branch);
		expect(stampToCarrier.get("s2")).toBe("u1");
		expect(stampToCarrier.has("s1")).toBe(false);
	});
});
