import { formatLocalMinute } from "./clock.js";
import type { CarrierDecisionV1, SessionAnchorV1, TimePolicyV1 } from "./types.js";

export function formatElapsedMinutes(totalMinutes: number): string {
	const safeMinutes = Math.max(0, Math.trunc(totalMinutes));
	const hours = Math.floor(safeMinutes / 60);
	const minutes = safeMinutes % 60;
	if (hours === 0) return `${minutes}分钟`;
	if (minutes === 0) return `${hours}小时`;
	return `${hours}小时${minutes}分钟`;
}

export function renderDecision(decision: CarrierDecisionV1, policy: TimePolicyV1): string | undefined {
	if (!decision.stamp) return undefined;
	if (decision.stamp.renderVersion !== 1 || policy.renderVersion !== 1) return undefined;

	const lines = [`sent_at: ${formatLocalMinute(decision.firstSentAtMs, policy.timeZone)}`];
	if (decision.stamp.elapsedMinutes !== undefined) {
		lines.push(`elapsed_since_last_activity: ${formatElapsedMinutes(decision.stamp.elapsedMinutes)}`);
	}
	return lines.join("\n");
}

export function renderSessionStart(anchor: SessionAnchorV1): string | undefined {
	if (anchor.policy.renderVersion !== 1) return undefined;
	return `session_started_at: ${formatLocalMinute(anchor.t0Ms, anchor.policy.timeZone)}`;
}
