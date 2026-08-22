import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./pi-types.js";
import type {
	ActivityV1,
	CarrierAssociation,
	CompletedActivityRef,
} from "./types.js";
import { isSessionMessageEntry } from "./state.js";

function isLlmMessage(message: AgentMessage): boolean {
	return message.role === "user" || message.role === "assistant" || message.role === "toolResult";
}

function messagesMatch(left: AgentMessage, right: AgentMessage): boolean {
	if (left.role !== right.role) return false;
	if (left.role === "user" && right.role === "user") return left.timestamp === right.timestamp;
	if (left.role === "assistant" && right.role === "assistant") return left.timestamp === right.timestamp;
	if (left.role === "toolResult" && right.role === "toolResult") {
		return left.toolCallId === right.toolCallId;
	}
	return false;
}

export function associateCarrierMessages(
	messages: readonly AgentMessage[],
	branch: readonly SessionEntry[],
): CarrierAssociation[] {
	const entries = branch.filter(isSessionMessageEntry);
	const result: CarrierAssociation[] = [];
	let branchIndex = entries.length - 1;

	for (let messageIndex = messages.length - 1; messageIndex >= 0 && branchIndex >= 0; messageIndex--) {
		const message = messages[messageIndex];
		if (!message || !isLlmMessage(message)) continue;
		let matched: SessionMessageEntry | undefined;
		for (; branchIndex >= 0; branchIndex--) {
			const candidate = entries[branchIndex];
			if (candidate && messagesMatch(candidate.message, message)) {
				matched = candidate;
				branchIndex--;
				break;
			}
		}
		if (!matched) continue;
		if (message.role === "user") {
			result.push({ messageIndex, entryId: matched.id, kind: "user", message });
		} else if (message.role === "toolResult") {
			result.push({
				messageIndex,
				entryId: matched.id,
				kind: "tool_result",
				toolCallId: message.toolCallId,
				message,
			});
		}
	}
	return result.sort((left, right) => left.messageIndex - right.messageIndex);
}

export function findTailCarrierGroup(
	messages: readonly AgentMessage[],
	associations: readonly CarrierAssociation[],
): CarrierAssociation[] {
	let lastLlmIndex = -1;
	let lastRole: AgentMessage["role"] | undefined;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message && isLlmMessage(message)) {
			lastLlmIndex = index;
			lastRole = message.role;
			break;
		}
	}
	if (lastLlmIndex < 0 || lastRole === "assistant") return [];

	let boundary = -1;
	for (let index = lastLlmIndex - 1; index >= 0; index--) {
		if (messages[index]?.role === "assistant") {
			boundary = index;
			break;
		}
	}
	const kind = lastRole === "user" ? "user" : "tool_result";
	return associations.filter(
		(association) => association.kind === kind && association.messageIndex > boundary,
	);
}

export function selectCarrier(
	group: readonly CarrierAssociation[],
	activities: ReadonlyMap<string, ActivityV1>,
): CarrierAssociation | undefined {
	if (group.length === 0) return undefined;
	if (group[0]?.kind === "user") {
		return group.reduce((latest, item) => (item.messageIndex > latest.messageIndex ? item : latest));
	}

	const completedByToolCallId = new Map<string, number>();
	for (const activity of activities.values()) {
		if (activity.kind === "tool") completedByToolCallId.set(activity.toolCallId, activity.completedAtMs);
	}
	return group.reduce((latest, item) => {
		const latestCompleted = latest.toolCallId ? completedByToolCallId.get(latest.toolCallId) : undefined;
		const itemCompleted = item.toolCallId ? completedByToolCallId.get(item.toolCallId) : undefined;
		if (itemCompleted !== undefined && latestCompleted !== undefined && itemCompleted !== latestCompleted) {
			return itemCompleted > latestCompleted ? item : latest;
		}
		if (itemCompleted !== undefined && latestCompleted === undefined) return item;
		if (itemCompleted === undefined && latestCompleted !== undefined) return latest;
		return item.messageIndex > latest.messageIndex ? item : latest;
	});
}

export function findPreviousCompletedActivity(
	carrier: CarrierAssociation,
	activities: ReadonlyMap<string, ActivityV1>,
): CompletedActivityRef | undefined {
	let previous: CompletedActivityRef | undefined;
	for (const activity of activities.values()) {
		if (activity.kind === "user") continue;
		if (activity.kind === "tool" && activity.toolCallId === carrier.toolCallId) continue;
		if (activity.kind === "assistant" && activity.messageEntryId === carrier.entryId) continue;
		const completedAtMs = activity.completedAtMs;
		if (!previous || completedAtMs > previous.completedAtMs) {
			previous = { key: activity.key, completedAtMs };
		}
	}
	return previous;
}
