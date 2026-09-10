import type { ContextEvent, ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import { ActivityTracker } from "./activity-tracker.js";
import {
	associateCarrierMessages,
	findPreviousCompletedActivity,
	findTailCarrierGroup,
	selectCarrier,
} from "./carrier.js";
import { createCarrierDecision, createNullDecision } from "./checkpoint.js";
import { readClock, resolveTimeZone, systemClock } from "./clock.js";
import {
	type ConfigLoadResult,
	type TimeContextConfig,
	freezePolicy,
	isValidIntervalMinutes,
	loadConfig,
} from "./config.js";
import {
	buildInactiveShowReport,
	buildShowReport,
	globalConfigPath,
	parseIntervalValue,
	parseTimeConfigArgs,
	USAGE,
	writeGlobalConfig,
} from "./commands.js";
import { runTimeConfigMenu } from "./time-config-menu.js";
import { transformContextMessages } from "./context-transform.js";
import { copyForkMetadata } from "./fork-copy.js";
import { renderDecision } from "./renderer.js";
import { resolvePolicy } from "./policy-revisions.js";
import type {
	AgentMessage,
	AssistantMessageEvent,
	MessageEndEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
} from "./pi-types.js";
import { carrierEntryIds, isSessionMessageEntry, recoverState } from "./state.js";
import { registerDecisionRenderer } from "./visibility.js";
import {
	ACTIVITY_FACTS_ENTRY,
	CARRIER_DECISION_ENTRY,
	POLICY_REVISIONS_ENTRY,
	SESSION_ANCHOR_ENTRY,
	type ActivityFactsV1,
	type CarrierAssociation,
	type CarrierDecisionV1,
	type Clock,
	type PolicyRevisionV1,
	type RecoveredState,
	type SessionAnchorV1,
	type TimePolicyV1,
} from "./types.js";

export interface RuntimeOptions {
	clock?: Clock;
	configLoader?: () => ConfigLoadResult;
	warn?: (message: string) => void;
	homeDirectory?: string;
}

function emptyState(): RecoveredState {
	return {
		activitiesByKey: new Map(),
		decisionsByCarrierId: new Map(),
		lastStampedCheckpointIndex: 0,
		revisions: [],
	};
}

export class TimeContextRuntime {
	private readonly pi: ExtensionAPI;
	private readonly clock: Clock;
	private readonly configLoader: () => ConfigLoadResult;
	private readonly externalWarn?: (message: string) => void;
	private readonly homeDirectory?: string;
	private readonly warnings = new Set<string>();
	private readonly tracker: ActivityTracker;
	private state: RecoveredState = emptyState();
	private activationCarrierIds = new Set<string>();
	private baselinePending = false;
	private refreshedEntryCount = -1;
	private refreshedEntryTailId?: string;
	private refreshedBranchCount = -1;
	private refreshedBranchTailId?: string;

	constructor(pi: ExtensionAPI, options: RuntimeOptions = {}) {
		this.pi = pi;
		this.clock = options.clock ?? systemClock;
		this.configLoader = options.configLoader ?? (() => loadConfig({ homeDirectory: this.homeDirectory }));
		this.externalWarn = options.warn;
		this.homeDirectory = options.homeDirectory;
		this.tracker = new ActivityTracker(this.clock, (message) => this.warn(message));
	}

	private warn(message: string): void {
		if (this.warnings.has(message)) return;
		this.warnings.add(message);
		if (this.externalWarn) {
			this.externalWarn(message);
		} else {
			console.warn(`[pi-time-context] ${message}`);
		}
	}

	private refresh(ctx: ExtensionContext, force = false): void {
		const entries = ctx.sessionManager.getEntries();
		const branch = ctx.sessionManager.getBranch();
		const entryTailId = entries.at(-1)?.id;
		const branchTailId = branch.at(-1)?.id;
		if (
			!force &&
			entries.length === this.refreshedEntryCount &&
			entryTailId === this.refreshedEntryTailId &&
			branch.length === this.refreshedBranchCount &&
			branchTailId === this.refreshedBranchTailId
		) {
			return;
		}

		this.state = recoverState(entries, branch, (message) => this.warn(message));
		this.refreshedEntryCount = entries.length;
		this.refreshedEntryTailId = entryTailId;
		this.refreshedBranchCount = branch.length;
		this.refreshedBranchTailId = branchTailId;
	}

	private createAnchor(
		origin: SessionAnchorV1["origin"],
		t0Ms: number,
		ctx: ExtensionContext,
	): SessionAnchorV1 {
		const loaded = this.loadConfigWithWarnings();
		for (const warning of loaded.warnings) this.warn(warning);
		return {
			version: 1,
			t0Ms,
			origin,
			policy: freezePolicy(loaded.config, (message) => this.warn(message)),
		};
	}

	private persistDecision(decision: CarrierDecisionV1): void {
		if (this.state.decisionsByCarrierId.has(decision.carrierEntryId)) return;
		this.pi.appendEntry(CARRIER_DECISION_ENTRY, decision);
		this.state.decisionsByCarrierId.set(decision.carrierEntryId, decision);
		if (decision.stamp) {
			this.state.lastStampedCheckpointIndex = Math.max(
				this.state.lastStampedCheckpointIndex,
				decision.checkpointIndex,
			);
		}
	}

	async onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		this.tracker.reset();
		this.baselinePending = false;
		const loaded = this.loadConfigWithWarnings();
		for (const warning of loaded.warnings) this.warn(warning);
		if (event.reason === "fork" && event.previousSessionFile) {
			await copyForkMetadata({
				previousSessionFile: event.previousSessionFile,
				currentEntries: ctx.sessionManager.getEntries(),
				currentBranch: ctx.sessionManager.getBranch(),
				append: (customType, data) => this.pi.appendEntry(customType, data),
				warn: (message) => this.warn(message),
			});
		}
		this.refresh(ctx, true);
		const branch = ctx.sessionManager.getBranch();
		this.activationCarrierIds = carrierEntryIds(branch);
		const branchHasUser = branch.some(
			(entry) => isSessionMessageEntry(entry) && entry.message.role === "user",
		);
		this.baselinePending =
			event.reason !== "fork" &&
			this.state.anchor?.origin === "first_user_processed" &&
			!branchHasUser &&
			this.state.decisionsByCarrierId.size === 0;
	}

	onMessageEnd(event: MessageEndEvent, ctx: ExtensionContext): void {
		const processedAtMs = this.tracker.onMessageEnd(event.message);
		if (event.message.role !== "user" || processedAtMs === undefined) return;
		this.refresh(ctx);
		if (this.state.anchor) return;
		const hasHistoricalUser = ctx.sessionManager
			.getBranch()
			.some((entry) => isSessionMessageEntry(entry) && entry.message.role === "user");
		if (hasHistoricalUser) return;

		const anchor = this.createAnchor("first_user_processed", processedAtMs, ctx);
		this.pi.appendEntry(SESSION_ANCHOR_ENTRY, anchor);
		this.state.anchor = anchor;
		this.baselinePending = true;
	}

	onMessageStart(message: AgentMessage): void {
		this.tracker.onMessageStart(message);
	}

	onMessageUpdate(message: AgentMessage, event: AssistantMessageEvent): void {
		this.tracker.onMessageUpdate(message, event);
	}

	onToolStart(event: ToolExecutionStartEvent): void {
		this.tracker.onToolStart(event.toolCallId);
	}

	onToolEnd(event: ToolExecutionEndEvent): void {
		this.tracker.onToolEnd(event.toolCallId, event.isError);
	}

	private flushActivities(ctx: ExtensionContext): void {
		this.refresh(ctx);
		const activities = this.tracker.resolveActivities(
			ctx.sessionManager.getBranch(),
			this.state.activitiesByKey,
		);
		if (activities.length === 0) return;
		const facts = { version: 1, activities } satisfies ActivityFactsV1;
		this.pi.appendEntry(ACTIVITY_FACTS_ENTRY, facts);
		for (const activity of activities) this.state.activitiesByKey.set(activity.key, activity);
	}

	onTurnEnd(ctx: ExtensionContext): void {
		this.flushActivities(ctx);
	}

	onSessionShutdown(ctx: ExtensionContext): void {
		this.flushActivities(ctx);
	}

	onTreeChanged(ctx: ExtensionContext): void {
		this.refresh(ctx);
		for (const id of carrierEntryIds(ctx.sessionManager.getBranch())) this.activationCarrierIds.add(id);
	}

	private createDecisionsForNewGroup(
		group: readonly CarrierAssociation[],
		requestAtMs: number | undefined,
		ctx: ExtensionContext,
	): void {
		const eligible = group.filter(
			(carrier) =>
				!this.state.decisionsByCarrierId.has(carrier.entryId) &&
				!this.activationCarrierIds.has(carrier.entryId),
		);
		const selected =
			(this.baselinePending ? eligible.find((carrier) => carrier.kind === "user") : undefined) ??
			selectCarrier(eligible, this.state.activitiesByKey);
		if (!selected) return;

		let migrationCreated = false;
		if (!this.state.anchor) {
			if (requestAtMs === undefined) {
				this.warn("Clock is invalid; leaving this new carrier unstamped");
				for (const carrier of eligible) this.activationCarrierIds.add(carrier.entryId);
				return;
			}
			const anchor = this.createAnchor("legacy_activation", requestAtMs, ctx);
			this.pi.appendEntry(SESSION_ANCHOR_ENTRY, anchor);
			this.state.anchor = anchor;
			migrationCreated = true;
		}

		const anchor = this.state.anchor;
		if (!anchor) return;
		const isBaseline = migrationCreated || (this.baselinePending && selected.kind === "user");
		const firstSentAtMs = isBaseline ? anchor.t0Ms : (requestAtMs ?? anchor.t0Ms);
		const policy = resolvePolicy(anchor, this.state.revisions, firstSentAtMs);
		if (!isBaseline && requestAtMs === undefined) {
			this.warn("Clock is invalid; persisting a null decision for this carrier");
			this.persistDecision(
				createNullDecision(selected.entryId, selected.kind, firstSentAtMs, anchor.t0Ms, policy),
			);
		} else {
			const result = createCarrierDecision({
				carrierEntryId: selected.entryId,
				carrierKind: selected.kind,
				firstSentAtMs,
				t0Ms: anchor.t0Ms,
				policy,
				lastStampedCheckpointIndex: this.state.lastStampedCheckpointIndex,
				isBaseline,
				previousActivity: findPreviousCompletedActivity(selected, this.state.activitiesByKey),
			});
			if (result.clockAnomaly) {
				this.warn("System clock moved backwards; elapsed_since_last_activity was omitted");
			}
			this.persistDecision(result.decision);
		}

		for (const carrier of eligible) {
			if (carrier.entryId === selected.entryId) continue;
			this.persistDecision(
				createNullDecision(carrier.entryId, carrier.kind, requestAtMs ?? anchor.t0Ms, anchor.t0Ms, policy),
			);
		}
		for (const carrier of eligible) this.activationCarrierIds.add(carrier.entryId);
		if (isBaseline) this.baselinePending = false;
	}

	onContext(event: ContextEvent, ctx: ExtensionContext): { messages: typeof event.messages } {
		const requestAtMs = readClock(this.clock);
		if (requestAtMs === undefined) this.warn("Clock returned an invalid provider request time");
		this.tracker.noteContextRequest(requestAtMs);
		this.refresh(ctx);
		const associations = associateCarrierMessages(event.messages, ctx.sessionManager.getBranch());
		const group = findTailCarrierGroup(event.messages, associations);
		this.createDecisionsForNewGroup(group, requestAtMs, ctx);

		const anchor = this.state.anchor;
		if (!anchor) return { messages: [...event.messages] };
		return {
			messages: transformContextMessages(
				event.messages,
				associations,
				this.state.decisionsByCarrierId,
				anchor,
				this.state.revisions,
			),
		};
	}

	private appendRevision(policy: TimePolicyV1): void {
		const nowMs = readClock(this.clock);
		if (nowMs === undefined) {
			this.warn("Clock is invalid; policy revision was not recorded");
			return;
		}
		const revision: PolicyRevisionV1 = {
			version: 1,
			effectiveFromMs: nowMs,
			policy,
			source: "command",
			scope: "global",
		};
		this.pi.appendEntry(POLICY_REVISIONS_ENTRY, revision);
		this.state.revisions = [...this.state.revisions, revision].sort(
			(a, b) => a.effectiveFromMs - b.effectiveFromMs,
		);
	}

	private currentEffectivePolicy(): { anchor: SessionAnchorV1; policy: TimePolicyV1 } | undefined {
		if (!this.state.anchor) return undefined;
		const nowMs = readClock(this.clock);
		if (nowMs === undefined) return undefined;
		return { anchor: this.state.anchor, policy: resolvePolicy(this.state.anchor, this.state.revisions, nowMs) };
	}

	private loadConfigWithWarnings(): ConfigLoadResult {
		const loaded = this.configLoader();
		for (const warning of loaded.warnings) this.warn(warning);
		return loaded;
	}

	private loadCurrentConfig(ctx: ExtensionContext): TimeContextConfig {
		const effective = this.currentEffectivePolicy();
		if (effective) {
			return {
				checkpointIntervalMinutes: Math.round(effective.policy.checkpointIntervalMs / 60_000),
				previousActivityThresholdMinutes: Math.round(effective.policy.previousActivityThresholdMs / 60_000),
				timeZone: effective.policy.timeZone,
				stampEveryMessage: effective.policy.stampEveryMessage,
			};
		}
		const loaded = this.loadConfigWithWarnings();
		for (const warning of loaded.warnings) this.warn(warning);
		return loaded.config;
	}

	private computeChange(
		action: "interval" | "threshold" | "tz" | "every",
		currentConfig: TimeContextConfig,
		value: { minutes?: number; timeZone?: string; every?: boolean },
	): { patch: Partial<TimeContextConfig>; nextPolicy: TimePolicyV1; error?: string } {
		const base = freezePolicy(currentConfig, (message) => this.warn(message));
		if (action === "every") {
			const enabled = value.every ?? !currentConfig.stampEveryMessage;
			return { patch: { stampEveryMessage: enabled }, nextPolicy: { ...base, stampEveryMessage: enabled } };
		}
		if (action === "interval") {
			const minutes = value.minutes;
			if (minutes === undefined || !isValidIntervalMinutes(minutes)) {
				return { patch: {}, nextPolicy: base, error: "Interval must be an integer between 1 and 10080 minutes" };
			}
			return {
				patch: { checkpointIntervalMinutes: minutes, stampEveryMessage: false },
				nextPolicy: { ...base, checkpointIntervalMs: minutes * 60_000, stampEveryMessage: false },
			};
		}
		if (action === "threshold") {
			const minutes = value.minutes;
			if (minutes === undefined || !isValidIntervalMinutes(minutes)) {
				return { patch: {}, nextPolicy: base, error: "Threshold must be an integer between 1 and 10080 minutes" };
			}
			return {
				patch: { previousActivityThresholdMinutes: minutes },
				nextPolicy: { ...base, previousActivityThresholdMs: minutes * 60_000 },
			};
		}
		const requested = value.timeZone ?? "";
		const resolved = resolveTimeZone(requested);
		if (!resolved) {
			return { patch: {}, nextPolicy: base, error: `Unrecognized time zone "${requested}" (use local, UTC, or an IANA name)` };
		}
		return { patch: { timeZone: requested }, nextPolicy: { ...base, timeZone: resolved } };
	}

	private commitChange(
		effective: { anchor: SessionAnchorV1; policy: TimePolicyV1 } | undefined,
		change: { patch: Partial<TimeContextConfig>; nextPolicy: TimePolicyV1 },
		action: "interval" | "threshold" | "tz" | "every",
	): { summary: string } | { error: string } {
		const targetPath = globalConfigPath({ homeDirectory: this.homeDirectory });
		try {
			writeGlobalConfig(targetPath, change.patch);
		} catch (error) {
			return { error: `Failed to write ${targetPath}: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (effective) this.appendRevision(change.nextPolicy);
		const policy = change.nextPolicy;
		const summary =
			action === "every"
				? `Stamp every message: ${policy.stampEveryMessage ? "on" : "off"}`
				: action === "tz"
					? `Time zone: ${policy.timeZone}`
					: action === "interval"
						? `Checkpoint interval: ${policy.stampEveryMessage ? "every message" : `${Math.round(policy.checkpointIntervalMs / 60_000)} minutes`}`
						: `Previous-activity threshold: ${Math.round(policy.previousActivityThresholdMs / 60_000)} minutes`;
		const scopeNote = effective
			? "written to the global config; applies to subsequent messages"
			: "written to the global config; takes effect when the session activates (first user message)";
		return { summary: `${summary} (${scopeNote})` };
	}

	private showReport(ctx: ExtensionCommandContext): void {
		const nowMs = readClock(this.clock);
		if (nowMs === undefined || !this.state.anchor) {
			ctx.ui.notify(
				buildInactiveShowReport(() => this.loadConfigWithWarnings().config),
			);
			return;
		}
		ctx.ui.notify(
			buildShowReport({
				anchor: this.state.anchor,
				revisions: this.state.revisions,
				decisions: [...this.state.decisionsByCarrierId.values()],
				nowMs,
			}),
		);
	}

	private async runInteractiveMenu(ctx: ExtensionCommandContext): Promise<void> {
		await runTimeConfigMenu(ctx, {
			loadConfig: () => this.loadCurrentConfig(ctx),
			commit: (action, value) => {
				const effective = this.currentEffectivePolicy();
				const config = this.loadCurrentConfig(ctx);
				const change = this.computeChange(action, config, value);
				if (change.error) return { error: change.error };
				return this.commitChange(effective, change, action);
			},
		});
	}

	async handleTimeConfig(args: string, ctx: ExtensionCommandContext): Promise<void> {
		if (args.trim() === "") {
			if (ctx.hasUI) {
				await this.runInteractiveMenu(ctx);
				return;
			}
			ctx.ui.notify(
				"Interactive UI is unavailable in this mode; use subcommands:\n\n" + USAGE,
				"warning",
			);
			return;
		}
		const parsed = parseTimeConfigArgs(args);
		if (!parsed.args) {
			ctx.ui.notify(parsed.error ?? "Failed to parse arguments", "error");
			return;
		}
		const { action } = parsed.args;

		if (action === "show") {
			this.showReport(ctx);
			return;
		}

		const effective = this.currentEffectivePolicy();
		const currentConfig = this.loadCurrentConfig(ctx);

		const value =
			action === "every"
				? {}
				: action === "tz"
					? { timeZone: parsed.args.value ?? "" }
					: { minutes: parseIntervalValue(parsed.args.value ?? "") };
		const change = this.computeChange(action, currentConfig, value);
		if (change.error) {
			ctx.ui.notify(change.error, "error");
			return;
		}
		const result = this.commitChange(effective, change, action);
		if ("error" in result) {
			ctx.ui.notify(result.error, "error");
			return;
		}
		ctx.ui.notify(result.summary);
	}
}

export function registerTimeContextExtension(pi: ExtensionAPI, options: RuntimeOptions = {}): TimeContextRuntime {
	const runtime = new TimeContextRuntime(pi, options);
	registerDecisionRenderer(pi);
	pi.registerCommand("time-config", {
		description: "View/modify pi-time-context configuration (interval, threshold, time zone, every-message mode)",
		handler: (args, ctx) => runtime.handleTimeConfig(args, ctx),
	});
	pi.on("session_start", (event, ctx) => runtime.onSessionStart(event, ctx));
	pi.on("session_tree", (_event, ctx) => runtime.onTreeChanged(ctx));
	pi.on("context", (event, ctx) => runtime.onContext(event, ctx));
	pi.on("message_start", (event) => runtime.onMessageStart(event.message));
	pi.on("message_update", (event) => runtime.onMessageUpdate(event.message, event.assistantMessageEvent));
	pi.on("message_end", (event, ctx) => runtime.onMessageEnd(event, ctx));
	pi.on("tool_execution_start", (event) => runtime.onToolStart(event));
	pi.on("tool_execution_end", (event) => runtime.onToolEnd(event));
	pi.on("turn_end", (_event, ctx) => runtime.onTurnEnd(ctx));
	pi.on("session_shutdown", (_event, ctx) => runtime.onSessionShutdown(ctx));
	return runtime;
}

export default function piTimeContext(pi: ExtensionAPI): void {
	registerTimeContextExtension(pi);
}
