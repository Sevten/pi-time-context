import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./pi-types.js";
import {
	ACTIVITY_FACTS_ENTRY,
	CARRIER_DECISION_ENTRY,
	SESSION_ANCHOR_ENTRY,
	type ActivityV1,
	type CarrierDecisionV1,
	type RecoveredState,
	type WarningSink,
} from "./types.js";
import {
	parseActivityFacts,
	parseCarrierDecision,
	parseSessionAnchor,
	recordsFromEntries,
} from "./persistence.js";

export interface BranchReferences {
	messageEntryIds: Set<string>;
	toolCallIds: Set<string>;
}

export function isSessionMessageEntry(entry: SessionEntry): entry is SessionMessageEntry {
	return entry.type === "message";
}

function collectToolCallIds(message: AgentMessage, target: Set<string>): void {
	if (message.role === "assistant") {
		for (const block of message.content) {
			if (block.type === "toolCall") target.add(block.id);
		}
	} else if (message.role === "toolResult") {
		target.add(message.toolCallId);
	}
}

export function collectBranchReferences(branch: readonly SessionEntry[]): BranchReferences {
	const messageEntryIds = new Set<string>();
	const toolCallIds = new Set<string>();
	for (const entry of branch) {
		if (!isSessionMessageEntry(entry)) continue;
		messageEntryIds.add(entry.id);
		collectToolCallIds(entry.message, toolCallIds);
	}
	return { messageEntryIds, toolCallIds };
}

export function isActivityOnBranch(activity: ActivityV1, references: BranchReferences): boolean {
	if (activity.kind === "tool") {
		return activity.toolResultEntryId !== undefined
			? references.messageEntryIds.has(activity.toolResultEntryId)
			: references.toolCallIds.has(activity.toolCallId);
	}
	return references.messageEntryIds.has(activity.messageEntryId);
}

export function recoverState(
	entries: readonly SessionEntry[],
	branch: readonly SessionEntry[],
	warn?: WarningSink,
): RecoveredState {
	const references = collectBranchReferences(branch);
	const activitiesByKey = new Map<string, ActivityV1>();
	const decisionsByCarrierId = new Map<string, CarrierDecisionV1>();
	let anchor: RecoveredState["anchor"];

	for (const record of recordsFromEntries(entries)) {
		if (record.customType === SESSION_ANCHOR_ENTRY && !anchor) {
			anchor = parseSessionAnchor(record.data, warn);
			continue;
		}
		if (record.customType === ACTIVITY_FACTS_ENTRY) {
			const facts = parseActivityFacts(record.data, warn);
			for (const activity of facts?.activities ?? []) {
				if (isActivityOnBranch(activity, references) && !activitiesByKey.has(activity.key)) {
					activitiesByKey.set(activity.key, activity);
				}
			}
			continue;
		}
		if (record.customType === CARRIER_DECISION_ENTRY) {
			const decision = parseCarrierDecision(record.data, warn);
			if (
				decision &&
				references.messageEntryIds.has(decision.carrierEntryId) &&
				!decisionsByCarrierId.has(decision.carrierEntryId)
			) {
				decisionsByCarrierId.set(decision.carrierEntryId, decision);
			}
		}
	}

	let lastStampedCheckpointIndex = 0;
	for (const decision of decisionsByCarrierId.values()) {
		if (decision.stamp) {
			lastStampedCheckpointIndex = Math.max(lastStampedCheckpointIndex, decision.checkpointIndex);
		}
	}
	return { anchor, activitiesByKey, decisionsByCarrierId, lastStampedCheckpointIndex };
}

export function carrierEntryIds(branch: readonly SessionEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const entry of branch) {
		if (
			isSessionMessageEntry(entry) &&
			(entry.message.role === "user" || entry.message.role === "toolResult")
		) {
			ids.add(entry.id);
		}
	}
	return ids;
}
