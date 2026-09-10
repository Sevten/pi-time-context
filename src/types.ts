import type { AgentMessage } from "./pi-types.js";

export const SESSION_ANCHOR_ENTRY = "pi-time-context/session-anchor";
export const ACTIVITY_FACTS_ENTRY = "pi-time-context/activity-facts";
export const CARRIER_DECISION_ENTRY = "pi-time-context/carrier-decision";
export const POLICY_REVISIONS_ENTRY = "pi-time-context/policy-revision";

export type AnchorOrigin = "first_user_processed" | "legacy_activation";
export type CarrierKind = "user" | "tool_result";

export interface Clock {
	now(): number;
}

export interface TimePolicyV1 {
	checkpointIntervalMs: number;
	previousActivityThresholdMs: number;
	timeZone: string;
	renderVersion: 1;
	stampEveryMessage: boolean;
}

export type PolicyRevisionScope = "project" | "global";

export interface PolicyRevisionV1 {
	version: 1;
	effectiveFromMs: number;
	policy: TimePolicyV1;
	source: "command";
	scope: PolicyRevisionScope;
}

export interface SessionAnchorV1 {
	version: 1;
	t0Ms: number;
	origin: AnchorOrigin;
	policy: TimePolicyV1;
}

export interface UserActivityV1 {
	key: string;
	kind: "user";
	messageEntryId: string;
	processedAtMs: number;
}

export interface AssistantActivityV1 {
	key: string;
	kind: "assistant";
	messageEntryId: string;
	requestedAtMs?: number;
	streamStartedAtMs?: number;
	firstContentAtMs?: number;
	completedAtMs: number;
}

export interface ToolActivityV1 {
	key: string;
	kind: "tool";
	toolCallId: string;
	toolResultEntryId?: string;
	startedAtMs: number;
	completedAtMs: number;
	isError: boolean;
}

export type ActivityV1 = UserActivityV1 | AssistantActivityV1 | ToolActivityV1;

export interface ActivityFactsV1 {
	version: 1;
	activities: ActivityV1[];
}

export interface CarrierStampV1 {
	renderVersion: 1;
	previousActivityKey?: string;
	elapsedMinutes?: number;
}

export interface CarrierDecisionV1 {
	version: 1;
	carrierEntryId: string;
	carrierKind: CarrierKind;
	firstSentAtMs: number;
	checkpointIndex: number;
	stamp: CarrierStampV1 | null;
}

export interface CompletedActivityRef {
	key: string;
	completedAtMs: number;
}

export interface CarrierAssociation {
	messageIndex: number;
	entryId: string;
	kind: CarrierKind;
	toolCallId?: string;
	message: AgentMessage;
}

export interface RecoveredState {
	anchor?: SessionAnchorV1;
	activitiesByKey: Map<string, ActivityV1>;
	decisionsByCarrierId: Map<string, CarrierDecisionV1>;
	lastStampedCheckpointIndex: number;
	revisions: PolicyRevisionV1[];
}

export type WarningSink = (message: string) => void;
