import { roundElapsedMinutes } from "./clock.js";
import type {
	CarrierDecisionV1,
	CarrierKind,
	CompletedActivityRef,
	TimePolicyV1,
} from "./types.js";

export interface DecisionInput {
	carrierEntryId: string;
	carrierKind: CarrierKind;
	firstSentAtMs: number;
	t0Ms: number;
	policy: TimePolicyV1;
	lastStampedCheckpointIndex: number;
	isBaseline: boolean;
	previousActivity?: CompletedActivityRef;
}

export interface DecisionResult {
	decision: CarrierDecisionV1;
	clockAnomaly?: "backwards";
}

export function checkpointIndexAt(firstSentAtMs: number, t0Ms: number, policy: TimePolicyV1): number {
	return Math.floor((firstSentAtMs - t0Ms) / policy.checkpointIntervalMs);
}

export function createCarrierDecision(input: DecisionInput): DecisionResult {
	const checkpointIndex = input.isBaseline ? 0 : checkpointIndexAt(input.firstSentAtMs, input.t0Ms, input.policy);
	// In every-message mode every new carrier is stamped; the checkpoint index is
	// still recorded so switching back to interval mode resumes at the current bucket.
	const checkpointDue = input.policy.stampEveryMessage || checkpointIndex > input.lastStampedCheckpointIndex;

	if (!input.isBaseline && !checkpointDue) {
		return {
			decision: {
				version: 1,
				carrierEntryId: input.carrierEntryId,
				carrierKind: input.carrierKind,
				firstSentAtMs: input.firstSentAtMs,
				checkpointIndex,
				stamp: null,
			},
		};
	}

	const previous = input.isBaseline ? undefined : input.previousActivity;
	const gapMs = previous ? input.firstSentAtMs - previous.completedAtMs : undefined;
	const backwards = gapMs !== undefined && gapMs < 0;
	const includeElapsed =
		gapMs !== undefined && !backwards && gapMs > input.policy.previousActivityThresholdMs;

	return {
		decision: {
			version: 1,
			carrierEntryId: input.carrierEntryId,
			carrierKind: input.carrierKind,
			firstSentAtMs: input.firstSentAtMs,
			checkpointIndex,
			stamp: {
				renderVersion: input.policy.renderVersion,
				previousActivityKey: includeElapsed ? previous?.key : undefined,
				elapsedMinutes: includeElapsed && gapMs !== undefined ? roundElapsedMinutes(gapMs) : undefined,
			},
		},
		clockAnomaly: backwards ? "backwards" : undefined,
	};
}

export function createNullDecision(
	carrierEntryId: string,
	carrierKind: CarrierKind,
	firstSentAtMs: number,
	t0Ms: number,
	policy: TimePolicyV1,
): CarrierDecisionV1 {
	return {
		version: 1,
		carrierEntryId,
		carrierKind,
		firstSentAtMs,
		checkpointIndex: checkpointIndexAt(firstSentAtMs, t0Ms, policy),
		stamp: null,
	};
}
