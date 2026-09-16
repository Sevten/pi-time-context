import { formatIsoMinute } from "./clock.js";
import type { CarrierDecisionV1, SessionAnchorV1, TimePolicyV1 } from "./types.js";

/** Marker substring used to detect whether the prompt note was already appended. */
export const STAMP_MARKER = "⟦TIME";

/**
 * Fixed system-prompt note explaining the ⟦TIME⟧ annotations. Appended once
 * per session via before_agent_start; load-bearing because ⟦ ⟧ (U+27E6/U+27E7)
 * has no training-data precedent the model could lean on.
 */
export const SYSTEM_PROMPT_NOTE =
	"Lines like ⟦TIME event=... at=...⟧ are wall-clock annotations injected by the agent harness: " +
	"event names what happened, at is when it happened, idle (only on user_message_sent) is how long " +
	"the conversation had been inactive when this message arrived, and covers_from/covers_until " +
	"(on context_summary_created) mark the time span of the conversation that a summary replaces. " +
	"They are metadata, not part of the message or tool output; use them only to stay aware of the " +
	"current time and elapsed time.";

export function formatElapsedMinutes(totalMinutes: number): string {
	const safeMinutes = Math.max(0, Math.trunc(totalMinutes));
	const hours = Math.floor(safeMinutes / 60);
	const minutes = safeMinutes % 60;
	if (hours === 0) return `${minutes}m`;
	if (minutes === 0) return `${hours}h`;
	return `${hours}h${minutes}m`;
}

export function renderDecision(decision: CarrierDecisionV1, policy: TimePolicyV1): string | undefined {
	if (!decision.stamp) return undefined;
	const event = decision.carrierKind === "user" ? "user_message_sent" : "tool_result_returned";
	const parts = [`⟦TIME event=${event}`, `at=${formatIsoMinute(decision.firstSentAtMs, policy.timeZone)}`];
	// Tool results never carry idle: a gap on a tool result is usually the
	// tool's own execution time, not user inactivity.
	if (decision.carrierKind === "user" && decision.stamp.elapsedMinutes !== undefined) {
		parts.push(`idle=${formatElapsedMinutes(decision.stamp.elapsedMinutes)}`);
	}
	return `${parts.join(" ")}⟧`;
}

/**
 * Stamp for the compaction summary: the two times the model needs after
 * compaction are when the session began and when the covered activity ended.
 * No creation timestamp: when the summary was produced is irrelevant.
 */
export function renderSummaryStamp(
	anchor: SessionAnchorV1,
	policy: TimePolicyV1,
	coverageUntilMs?: number,
): string {
	const parts = [
		"⟦TIME event=context_summary_created",
		`covers_from=${formatIsoMinute(anchor.t0Ms, policy.timeZone)}`,
	];
	if (coverageUntilMs !== undefined) {
		parts.push(`covers_until=${formatIsoMinute(coverageUntilMs, policy.timeZone)}`);
	}
	return `${parts.join(" ")}⟧`;
}
