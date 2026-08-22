import type { AgentMessage } from "./pi-types.js";
import type {
	CarrierAssociation,
	CarrierDecisionV1,
	TimePolicyV1,
} from "./types.js";
import { renderDecision } from "./renderer.js";

export function appendStamp(message: AgentMessage, stampText: string): AgentMessage {
	if (message.role === "user") {
		const content =
			typeof message.content === "string"
				? [{ type: "text" as const, text: message.content }]
				: [...message.content];
		return { ...message, content: [...content, { type: "text", text: stampText }] };
	}
	if (message.role === "toolResult") {
		return { ...message, content: [...message.content, { type: "text", text: stampText }] };
	}
	return message;
}

export function transformContextMessages(
	messages: readonly AgentMessage[],
	associations: readonly CarrierAssociation[],
	decisions: ReadonlyMap<string, CarrierDecisionV1>,
	policy: TimePolicyV1,
): AgentMessage[] {
	const next = [...messages];
	let changed = false;
	for (const association of associations) {
		const decision = decisions.get(association.entryId);
		if (!decision) continue;
		const rendered = renderDecision(decision, policy);
		if (!rendered) continue;
		const message = next[association.messageIndex];
		if (!message) continue;
		next[association.messageIndex] = appendStamp(message, rendered);
		changed = true;
	}
	return changed ? next : [...messages];
}
