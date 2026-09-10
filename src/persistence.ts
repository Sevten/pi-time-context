import { readFile } from "node:fs/promises";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { isValidEpochMs, resolveTimeZone } from "./clock.js";
import {
	ACTIVITY_FACTS_ENTRY,
	CARRIER_DECISION_ENTRY,
	POLICY_REVISIONS_ENTRY,
	SESSION_ANCHOR_ENTRY,
	type ActivityFactsV1,
	type ActivityV1,
	type CarrierDecisionV1,
	type PolicyRevisionV1,
	type SessionAnchorV1,
	type TimePolicyV1,
	type WarningSink,
} from "./types.js";

export interface CustomRecord {
	customType: string;
	data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteEpoch(value: unknown): value is number {
	return typeof value === "number" && isValidEpochMs(value);
}

function isPositiveFinite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function parsePolicy(data: unknown, warn?: WarningSink): TimePolicyV1 | undefined {
	if (!isRecord(data) || !isRecord(data.policy)) return undefined;
	const raw = data.policy;
	if (
		!isPositiveFinite(raw.checkpointIntervalMs) ||
		!isPositiveFinite(raw.previousActivityThresholdMs) ||
		(typeof raw.timeZone !== "string" || !resolveTimeZone(raw.timeZone)) ||
		raw.renderVersion !== 1
	) {
		return undefined;
	}
	return {
		checkpointIntervalMs: raw.checkpointIntervalMs,
		previousActivityThresholdMs: raw.previousActivityThresholdMs,
		timeZone: raw.timeZone,
		renderVersion: 1,
		stampEveryMessage: raw.stampEveryMessage === true,
	};
}

function parseActivity(value: unknown): ActivityV1 | undefined {
	if (!isRecord(value) || typeof value.key !== "string" || typeof value.kind !== "string") return undefined;
	if (value.kind === "user") {
		if (typeof value.messageEntryId !== "string" || !isFiniteEpoch(value.processedAtMs)) return undefined;
		return {
			key: value.key,
			kind: "user",
			messageEntryId: value.messageEntryId,
			processedAtMs: value.processedAtMs,
		};
	}
	if (value.kind === "assistant") {
		if (typeof value.messageEntryId !== "string" || !isFiniteEpoch(value.completedAtMs)) return undefined;
		if (value.requestedAtMs !== undefined && !isFiniteEpoch(value.requestedAtMs)) return undefined;
		if (value.streamStartedAtMs !== undefined && !isFiniteEpoch(value.streamStartedAtMs)) return undefined;
		if (value.firstContentAtMs !== undefined && !isFiniteEpoch(value.firstContentAtMs)) return undefined;
		return {
			key: value.key,
			kind: "assistant",
			messageEntryId: value.messageEntryId,
			requestedAtMs: value.requestedAtMs,
			streamStartedAtMs: value.streamStartedAtMs,
			firstContentAtMs: value.firstContentAtMs,
			completedAtMs: value.completedAtMs,
		};
	}
	if (value.kind === "tool") {
		if (
			typeof value.toolCallId !== "string" ||
			!isFiniteEpoch(value.startedAtMs) ||
			!isFiniteEpoch(value.completedAtMs) ||
			typeof value.isError !== "boolean" ||
			(value.toolResultEntryId !== undefined && typeof value.toolResultEntryId !== "string")
		) {
			return undefined;
		}
		return {
			key: value.key,
			kind: "tool",
			toolCallId: value.toolCallId,
			toolResultEntryId: value.toolResultEntryId,
			startedAtMs: value.startedAtMs,
			completedAtMs: value.completedAtMs,
			isError: value.isError,
		};
	}
	return undefined;
}

export function parseSessionAnchor(data: unknown, warn?: WarningSink): SessionAnchorV1 | undefined {
	if (!isRecord(data)) {
		warn?.("Ignoring malformed session anchor");
		return undefined;
	}
	if (data.version !== 1) {
		warn?.(`Ignoring unsupported session anchor version ${String(data.version)}`);
		return undefined;
	}
	const policy = parsePolicy(data, warn);
	if (!isFiniteEpoch(data.t0Ms) || (data.origin !== "first_user_processed" && data.origin !== "legacy_activation") || !policy) {
		warn?.("Ignoring malformed session anchor version 1");
		return undefined;
	}
	return {
		version: 1,
		t0Ms: data.t0Ms,
		origin: data.origin,
		policy,
	};
}

export function parsePolicyRevision(data: unknown, warn?: WarningSink): PolicyRevisionV1 | undefined {
	if (!isRecord(data)) {
		warn?.("Ignoring malformed policy revision");
		return undefined;
	}
	if (data.version !== 1) {
		warn?.(`Ignoring unsupported policy revision version ${String(data.version)}`);
		return undefined;
	}
	const policy = parsePolicy(data, warn);
	if (
		!isFiniteEpoch(data.effectiveFromMs) ||
		!policy ||
		data.source !== "command" ||
		(data.scope !== "project" && data.scope !== "global")
	) {
		warn?.("Ignoring malformed policy revision version 1");
		return undefined;
	}
	return {
		version: 1,
		effectiveFromMs: data.effectiveFromMs,
		policy,
		source: data.source,
		scope: data.scope,
	};
}

export function parseActivityFacts(data: unknown, warn?: WarningSink): ActivityFactsV1 | undefined {
	if (!isRecord(data)) {
		warn?.("Ignoring malformed activity facts");
		return undefined;
	}
	if (data.version !== 1) {
		warn?.(`Ignoring unsupported activity facts version ${String(data.version)}`);
		return undefined;
	}
	if (!Array.isArray(data.activities)) {
		warn?.("Ignoring malformed activity facts version 1");
		return undefined;
	}
	const activities = data.activities.map(parseActivity);
	if (activities.some((activity) => activity === undefined)) {
		warn?.("Ignoring malformed activity facts version 1");
		return undefined;
	}
	return { version: 1, activities: activities.filter((activity): activity is ActivityV1 => activity !== undefined) };
}

export function parseCarrierDecision(data: unknown, warn?: WarningSink): CarrierDecisionV1 | undefined {
	if (!isRecord(data)) {
		warn?.("Ignoring malformed carrier decision");
		return undefined;
	}
	if (data.version !== 1) {
		warn?.(`Ignoring unsupported carrier decision version ${String(data.version)}`);
		return undefined;
	}
	if (
		typeof data.carrierEntryId !== "string" ||
		(data.carrierKind !== "user" && data.carrierKind !== "tool_result") ||
		!isFiniteEpoch(data.firstSentAtMs) ||
		typeof data.checkpointIndex !== "number" ||
		!Number.isInteger(data.checkpointIndex)
	) {
		warn?.("Ignoring malformed carrier decision version 1");
		return undefined;
	}

	if (data.stamp === null) {
		return {
			version: 1,
			carrierEntryId: data.carrierEntryId,
			carrierKind: data.carrierKind,
			firstSentAtMs: data.firstSentAtMs,
			checkpointIndex: data.checkpointIndex,
			stamp: null,
		};
	}
	if (
		!isRecord(data.stamp) ||
		data.stamp.renderVersion !== 1 ||
		(data.stamp.previousActivityKey !== undefined && typeof data.stamp.previousActivityKey !== "string") ||
		(data.stamp.elapsedMinutes !== undefined &&
			(typeof data.stamp.elapsedMinutes !== "number" ||
				!Number.isInteger(data.stamp.elapsedMinutes) ||
				data.stamp.elapsedMinutes < 0))
	) {
		warn?.("Ignoring malformed carrier decision stamp version 1");
		return undefined;
	}
	return {
		version: 1,
		carrierEntryId: data.carrierEntryId,
		carrierKind: data.carrierKind,
		firstSentAtMs: data.firstSentAtMs,
		checkpointIndex: data.checkpointIndex,
		stamp: {
			renderVersion: 1,
			previousActivityKey: data.stamp.previousActivityKey,
			elapsedMinutes: data.stamp.elapsedMinutes,
		},
	};
}

export function recordsFromEntries(entries: readonly SessionEntry[]): CustomRecord[] {
	return entries.flatMap((entry) =>
		entry.type === "custom" ? [{ customType: entry.customType, data: entry.data }] : [],
	);
}

export async function readCustomRecords(path: string, warn?: WarningSink): Promise<CustomRecord[]> {
	let contents: string;
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		warn?.(`Unable to read previous session metadata: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}

	const records: CustomRecord[] = [];
	for (const [index, line] of contents.split(/\r?\n/u).entries()) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (
				isRecord(parsed) &&
				parsed.type === "custom" &&
				typeof parsed.customType === "string" &&
				parsed.data !== undefined
			) {
				records.push({ customType: parsed.customType, data: parsed.data });
			}
		} catch {
			warn?.(`Ignoring malformed JSON in previous session at line ${index + 1}`);
		}
	}
	return records;
}

export function isTimeContextRecord(record: CustomRecord): boolean {
	return (
		record.customType === SESSION_ANCHOR_ENTRY ||
		record.customType === ACTIVITY_FACTS_ENTRY ||
		record.customType === CARRIER_DECISION_ENTRY
	);
}
