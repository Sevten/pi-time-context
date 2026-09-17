import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "./pi-types.js";
import {
	ACTIVITY_FACTS_ENTRY,
	CARRIER_DECISION_ENTRY,
	POLICY_REVISIONS_ENTRY,
	SESSION_ANCHOR_ENTRY,
	UI_STAMP_ENTRY,
	type ActivityV1,
	type CarrierDecisionV1,
	type PolicyRevisionV1,
	type RecoveredState,
	type WarningSink,
} from "./types.js";
import {
	parseActivityFacts,
	parseCarrierDecision,
	parsePolicyRevision,
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
	const revisions: PolicyRevisionV1[] = [];
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
		if (record.customType === POLICY_REVISIONS_ENTRY) {
			const revision = parsePolicyRevision(record.data, warn);
			if (revision) revisions.push(revision);
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
	return {
		anchor,
		activitiesByKey,
		decisionsByCarrierId,
		lastStampedCheckpointIndex,
		revisions: revisions.sort((a, b) => a.effectiveFromMs - b.effectiveFromMs),
	};
}

export interface UiStampAssociations {
	/** UI stamp entry id → carrier (user message) entry id. */
	stampToCarrier: Map<string, string>;
	/** Carrier entry ids that have at least one preceding UI stamp. */
	carriersWithStamp: Set<string>;
}

/**
 * Resolve UI stamp entries to their carrier by structural adjacency: a stamp
 * is valid when the next message entry on the branch is a user message. Any
 * intervening message (assistant, tool result) orphans the stamps queued
 * before it — their input never became a message. Non-message entries in
 * between are transparent.
 *
 * When several stamps precede the same user message (e.g. a handled input
 * immediately followed by a real one), only the stamp closest to the message
 * resolves; earlier ones stay unmapped and never render, so a carrier always
 * shows at most one stamp line above it.
 */
export function computeUiStampAssociations(branch: readonly SessionEntry[]): UiStampAssociations {
	const stampToCarrier = new Map<string, string>();
	const carriersWithStamp = new Set<string>();
	let pending: string[] = [];
	for (const entry of branch) {
		if (entry.type === "custom") {
			if (entry.customType === UI_STAMP_ENTRY) pending.push(entry.id);
			continue;
		}
		if (!isSessionMessageEntry(entry)) continue;
		if (entry.message.role === "user") {
			const stampId = pending.at(-1);
			if (stampId) {
				stampToCarrier.set(stampId, entry.id);
				carriersWithStamp.add(entry.id);
			}
		}
		pending = [];
	}
	return { stampToCarrier, carriersWithStamp };
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

/**
 * When the covered activity ended, i.e. the time boundary of the content the
 * latest compaction summary replaced. Kept entries start at the compaction's
 * firstKeptEntryId, so covered entries are the branch entries sitting before
 * that position. The covered set is a fixed branch prefix, so recomputing this
 * per request is deterministic and needs no persistence.
 */
export function computeCoverageUntilMs(
	branch: readonly SessionEntry[],
	activities: ReadonlyMap<string, ActivityV1>,
): number | undefined {
	let cutIndex = -1;
	for (let index = 0; index < branch.length; index++) {
		const entry = branch[index];
		if (entry.type !== "compaction") continue;
		const keptIndex = branch.findIndex((candidate) => candidate.id === entry.firstKeptEntryId);
		cutIndex = keptIndex === -1 ? index : Math.min(keptIndex, index);
	}
	if (cutIndex === -1) return undefined;

	const coveredIds = new Set<string>();
	for (let index = 0; index < cutIndex; index++) {
		const entry = branch[index];
		if (isSessionMessageEntry(entry)) coveredIds.add(entry.id);
	}

	let latest: number | undefined;
	for (const activity of activities.values()) {
		const entryId = activity.kind === "tool" ? activity.toolResultEntryId : activity.messageEntryId;
		if (!entryId || !coveredIds.has(entryId)) continue;
		const completedAtMs = activity.kind === "user" ? activity.processedAtMs : activity.completedAtMs;
		if (latest === undefined || completedAtMs > latest) latest = completedAtMs;
	}
	return latest;
}
