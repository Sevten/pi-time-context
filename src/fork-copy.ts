import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	parseActivityFacts,
	parseCarrierDecision,
	parseSessionAnchor,
	readCustomRecords,
} from "./persistence.js";
import { collectBranchReferences, isActivityOnBranch, recoverState } from "./state.js";
import {
	ACTIVITY_FACTS_ENTRY,
	CARRIER_DECISION_ENTRY,
	SESSION_ANCHOR_ENTRY,
	type ActivityFactsV1,
	type ActivityV1,
	type WarningSink,
} from "./types.js";

export interface ForkMetadataCopyInput {
	previousSessionFile: string;
	currentEntries: readonly SessionEntry[];
	currentBranch: readonly SessionEntry[];
	append(customType: string, data: unknown): void;
	warn?: WarningSink;
}

export async function copyForkMetadata(input: ForkMetadataCopyInput): Promise<void> {
	const sourceRecords = await readCustomRecords(input.previousSessionFile, input.warn);
	const current = recoverState(input.currentEntries, input.currentBranch, input.warn);
	const references = collectBranchReferences(input.currentBranch);

	if (!current.anchor) {
		for (const record of sourceRecords) {
			if (record.customType !== SESSION_ANCHOR_ENTRY) continue;
			const anchor = parseSessionAnchor(record.data, input.warn);
			if (anchor) {
				input.append(SESSION_ANCHOR_ENTRY, anchor);
				break;
			}
		}
	}

	const missingActivities: ActivityV1[] = [];
	const activityKeys = new Set(current.activitiesByKey.keys());
	for (const record of sourceRecords) {
		if (record.customType !== ACTIVITY_FACTS_ENTRY) continue;
		const facts = parseActivityFacts(record.data, input.warn);
		for (const activity of facts?.activities ?? []) {
			if (!activityKeys.has(activity.key) && isActivityOnBranch(activity, references)) {
				missingActivities.push(activity);
				activityKeys.add(activity.key);
			}
		}
	}
	if (missingActivities.length > 0) {
		input.append(ACTIVITY_FACTS_ENTRY, { version: 1, activities: missingActivities } satisfies ActivityFactsV1);
	}

	const decisionIds = new Set(current.decisionsByCarrierId.keys());
	for (const record of sourceRecords) {
		if (record.customType !== CARRIER_DECISION_ENTRY) continue;
		const decision = parseCarrierDecision(record.data, input.warn);
		if (
			decision &&
			references.messageEntryIds.has(decision.carrierEntryId) &&
			!decisionIds.has(decision.carrierEntryId)
		) {
			input.append(CARRIER_DECISION_ENTRY, decision);
			decisionIds.add(decision.carrierEntryId);
		}
	}
}
