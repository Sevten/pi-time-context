import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatElapsedMinutes } from "./renderer.js";
import { formatLocalMinute, resolveTimeZone } from "./clock.js";
import { CARRIER_DECISION_ENTRY } from "./types.js";
import type { CarrierDecisionV1 } from "./types.js";

/** Compact single-line text for a stamped decision, or undefined when unstamped. */
export function decisionDisplayText(decision: CarrierDecisionV1): string | undefined {
	if (!decision.stamp) return undefined;
	const parts = [`sent_at ${formatLocalMinute(decision.firstSentAtMs, resolveTimeZone("local") ?? "UTC")}`];
	if (decision.stamp.elapsedMinutes !== undefined) {
		parts.push(`Idle for ${formatElapsedMinutes(decision.stamp.elapsedMinutes)}`);
	}
	return parts.join(" · ");
}

/**
 * Inline TUI rendering for persisted carrier decisions. Display-only: the
 * session data and the model context are never touched. Rendering runs where
 * the decision entry sits on the timeline, directly after the stamped message.
 * Note: the host inserts a one-line spacer before every custom entry; that
 * spacing is not controllable from the renderer.
 */
export function registerDecisionRenderer(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<CarrierDecisionV1>(CARRIER_DECISION_ENTRY, (entry, { expanded }, theme) => {
		const decision = entry.data;
		if (!decision || decision.version !== 1) return undefined;
		const text = decisionDisplayText(decision);
		if (!text) return undefined;
		if (!expanded) return new Text(theme.fg("dim", text));
		const details = [
			text,
			theme.fg("dim", `carrier ${decision.carrierEntryId} · bucket ${decision.checkpointIndex}`),
		];
		return new Text(details.join("\n"));
	});
}
