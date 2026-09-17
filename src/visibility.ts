import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderDecision } from "./renderer.js";
import { resolveTimeZone } from "./clock.js";
import {
	CARRIER_DECISION_ENTRY,
	UI_STAMP_ENTRY,
} from "./types.js";
import type { CarrierDecisionV1, UiStampV1 } from "./types.js";

/**
 * Bridge between the entry renderers and the runtime's live view of the
 * branch. The UI stamp renderer is self-contained and needs no lookup; the
 * decision renderer uses this to avoid double-rendering stamps that a
 * preceding UI stamp entry already shows.
 */
export interface UiStampLookup {
	/** Whether a valid UI stamp entry precedes this carrier on the branch. */
	hasPrecedingStamp(carrierEntryId: string): boolean;
	/**
	 * The time zone the model context renders `atMs` in — the same
	 * resolvePolicy(anchor, revisions, atMs) chain the context transform uses,
	 * so the TUI line is byte-identical to the annotation the model receives.
	 * Undefined when the session has no anchor (the model sees no stamps).
	 */
	timeZoneFor(atMs: number): string | undefined;
}

/** Fallback for entries whose policy can no longer be resolved (should not happen). */
function fallbackTimeZone(): string {
	return resolveTimeZone("local") ?? "UTC";
}

/** The exact ⟦TIME⟧ annotation text the model receives, or undefined when unstamped. */
export function decisionModelText(
	decision: CarrierDecisionV1,
	timeZoneFor: (atMs: number) => string | undefined,
): string | undefined {
	return renderDecision(decision, timeZoneFor(decision.firstSentAtMs) ?? fallbackTimeZone());
}

/**
 * Inline TUI rendering. Display-only: the session data and the model context
 * are never touched. Each stamped message renders the exact annotation the
 * model sees, as a dim line above the message.
 *
 * The stamp line renders from a self-contained UI stamp entry appended when
 * the user submits input, so it appears *above* the message it belongs to and
 * is rendered at append time, before the message or its decision exist. The
 * carrier decision renderer is a fallback for legacy sessions whose messages
 * have no preceding UI stamp entry.
 *
 * Note: the host inserts a one-line spacer before every custom entry; that
 * spacing is not controllable from the renderer.
 */
export function registerDecisionRenderer(pi: ExtensionAPI, lookup: UiStampLookup): void {
	pi.registerEntryRenderer<UiStampV1>(UI_STAMP_ENTRY, (entry, { expanded }, theme) => {
		const data = entry.data;
		if (!data || data.version !== 1) return undefined;
		const decision: CarrierDecisionV1 = {
			version: 1,
			carrierEntryId: entry.id,
			carrierKind: "user",
			firstSentAtMs: data.sentAtMs,
			checkpointIndex: 0,
			stamp: { ...(data.elapsedMinutes !== undefined ? { elapsedMinutes: data.elapsedMinutes } : {}) },
		};
		const text = decisionModelText(decision, lookup.timeZoneFor);
		if (!text) return undefined;
		if (!expanded) return new Text(theme.fg("dim", text));
		const details = [text, theme.fg("dim", `stamp ${entry.id} · submitted with the message below`)];
		return new Text(details.join("\n"));
	});

	pi.registerEntryRenderer<CarrierDecisionV1>(CARRIER_DECISION_ENTRY, (entry, { expanded }, theme) => {
		const decision = entry.data;
		if (!decision || decision.version !== 1) return undefined;
		const text = decisionModelText(decision, lookup.timeZoneFor);
		if (!text) return undefined;
		if (lookup.hasPrecedingStamp(decision.carrierEntryId)) {
			// The stamp line is rendered by the preceding UI stamp entry above
			// the message; avoid rendering it twice.
			if (!expanded) return undefined;
			return new Text(theme.fg("dim", `carrier ${decision.carrierEntryId} · bucket ${decision.checkpointIndex}`));
		}
		if (!expanded) return new Text(theme.fg("dim", text));
		const details = [
			text,
			theme.fg("dim", `carrier ${decision.carrierEntryId} · bucket ${decision.checkpointIndex}`),
		];
		return new Text(details.join("\n"));
	});
}
