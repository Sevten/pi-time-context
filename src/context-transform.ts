import type { AgentMessage } from "./pi-types.js";
import { resolvePolicy } from "./policy-revisions.js";
import type {
	CarrierAssociation,
	CarrierDecisionV1,
	PolicyRevisionV1,
	SessionAnchorV1,
} from "./types.js";
import { renderDecision, renderSessionStart } from "./renderer.js";

export function prependStamp(message: AgentMessage, stampText: string): AgentMessage {
	const stamp = { type: "text" as const, text: stampText };
	if (message.role === "user") {
		const content =
			typeof message.content === "string"
				? [{ type: "text" as const, text: message.content }]
				: [...message.content];
		return { ...message, content: [stamp, ...content] };
	}
	if (message.role === "toolResult") {
		return { ...message, content: [stamp, ...message.content] };
	}
	if (message.role === "compactionSummary") {
		// The summary string is later wrapped in <summary> tags when sent to the
		// model, so the session start line lands inside that block, before the
		// summary itself. The persisted entry is never touched.
		return { ...message, summary: `${stampText}\n\n${message.summary}` };
	}
	return message;
}

export function transformContextMessages(
	messages: readonly AgentMessage[],
	associations: readonly CarrierAssociation[],
	decisions: ReadonlyMap<string, CarrierDecisionV1>,
	anchor: SessionAnchorV1,
	revisions: readonly PolicyRevisionV1[] = [],
): AgentMessage[] {
	const next = [...messages];
	let changed = false;

	// After compaction the session's first stamped message may no longer be part
	// of the context. Re-attach the session start time to the compaction summary
	// so the model still knows when the session began.
	if (next[0]?.role === "compactionSummary") {
		const sessionStart = renderSessionStart(anchor);
		if (sessionStart) {
			next[0] = prependStamp(next[0], sessionStart);
			changed = true;
		}
	}

	for (const association of associations) {
		const decision = decisions.get(association.entryId);
		if (!decision) continue;
		const policy = resolvePolicy(anchor, revisions, decision.firstSentAtMs);
		const rendered = renderDecision(decision, policy);
		if (!rendered) continue;
		const message = next[association.messageIndex];
		if (!message) continue;
		next[association.messageIndex] = prependStamp(message, rendered);
		changed = true;
	}
	return changed ? next : [...messages];
}
