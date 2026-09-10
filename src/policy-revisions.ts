import type { PolicyRevisionV1, SessionAnchorV1, TimePolicyV1 } from "./types.js";

/**
 * Resolve the policy effective at `atMs`: the latest revision whose
 * effectiveFromMs is <= atMs, otherwise the anchor's frozen policy.
 */
export function resolvePolicy(
	anchor: SessionAnchorV1,
	revisions: readonly PolicyRevisionV1[],
	atMs: number,
): TimePolicyV1 {
	let effective: TimePolicyV1 = anchor.policy;
	for (const revision of revisions) {
		if (revision.effectiveFromMs <= atMs && revision.effectiveFromMs >= anchor.t0Ms) {
			effective = revision.policy;
		}
	}
	return effective;
}

/** Sort revisions chronologically, keeping the first of equal timestamps. */
export function normalizeRevisions(
	revisions: readonly PolicyRevisionV1[],
): PolicyRevisionV1[] {
	return [...revisions].sort((a, b) => a.effectiveFromMs - b.effectiveFromMs);
}
