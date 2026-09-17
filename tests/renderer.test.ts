import { describe, expect, it } from "vitest";
import {
	formatElapsedMinutes,
	renderDecision,
	renderSummaryStamp,
	STAMP_MARKER,
	SYSTEM_PROMPT_NOTE,
} from "../src/renderer.js";
import type { CarrierDecisionV1 } from "../src/types.js";
import { anchor } from "./helpers.js";

const T0 = Date.UTC(2026, 7, 22, 6, 15, 59);

function decision(carrierKind: CarrierDecisionV1["carrierKind"], stamp: CarrierDecisionV1["stamp"]) {
	return {
		version: 1 as const,
		carrierEntryId: "u1",
		carrierKind,
		firstSentAtMs: T0,
		checkpointIndex: 1,
		stamp,
	};
}

describe("renderer", () => {
	it("renders a user stamp with idle in stable field order", () => {
		const rendered = renderDecision(decision("user", { elapsedMinutes: 135 }), "Asia/Shanghai");
		expect(rendered).toBe("⟦TIME event=user_message_sent at=2026-08-22T14:15+08:00 idle=2h15m⟧");
	});

	it("renders a user stamp without idle when absent", () => {
		const rendered = renderDecision(decision("user", {}), anchor().policy.timeZone);
		expect(rendered).toBe("⟦TIME event=user_message_sent at=2026-08-22T06:15+00:00⟧");
	});

	it("never renders idle on tool results, even if a legacy stamp carries it", () => {
		const rendered = renderDecision(decision("tool_result", { elapsedMinutes: 135 }), anchor().policy.timeZone);
		expect(rendered).toBe("⟦TIME event=tool_result_returned at=2026-08-22T06:15+00:00⟧");
	});

	it("renders no text for a null decision", () => {
		expect(renderDecision(decision("user", null), anchor().policy.timeZone)).toBeUndefined();
	});

	it("uses the mathematical white square brackets U+27E6/U+27E7", () => {
		const rendered = renderDecision(decision("user", {}), anchor().policy.timeZone)!;
		expect(rendered.codePointAt(0)).toBe(0x27e6);
		expect(rendered.codePointAt(rendered.length - 1)).toBe(0x27e7);
		expect(rendered).not.toContain("[TIME");
		expect(STAMP_MARKER).toBe("⟦TIME");
	});

	it("renders the summary stamp with the covered span and no creation time", () => {
		const base = anchor(Date.UTC(2026, 7, 22, 4, 0));
		const rendered = renderSummaryStamp(base, base.policy, Date.UTC(2026, 7, 22, 6, 0));
		expect(rendered).toBe(
			"⟦TIME event=context_summary_created covers_from=2026-08-22T04:00+00:00 covers_until=2026-08-22T06:00+00:00⟧",
		);
		expect(rendered).not.toContain("at=");
	});

	it("omits covers_until when no covered activity is known", () => {
		const base = anchor(0);
		expect(renderSummaryStamp(base, base.policy)).toBe(
			"⟦TIME event=context_summary_created covers_from=1970-01-01T00:00+00:00⟧",
		);
	});

	it("keeps the prompt note self-describing and idempotency marker aligned", () => {
		expect(SYSTEM_PROMPT_NOTE).toContain(STAMP_MARKER);
		expect(SYSTEM_PROMPT_NOTE).toContain("covers_from");
		expect(SYSTEM_PROMPT_NOTE).toContain("metadata");
	});

	it("renders elapsed values without redundant components", () => {
		expect(formatElapsedMinutes(35)).toBe("35m");
		expect(formatElapsedMinutes(120)).toBe("2h");
		expect(formatElapsedMinutes(135)).toBe("2h15m");
	});
});
