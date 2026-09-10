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
	loadConfig,
} from "./config.js";
import {
	buildShowReport,
	configPaths,
	parseIntervalValue,
	parseTimeConfigArgs,
	statusLine,
	writeConfigLayer,
} from "./commands.js";
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
	configLoader?: (cwd: string, includeProjectConfig: boolean) => ConfigLoadResult;
	warn?: (message: string) => void;
	homeDirectory?: string;
	configDirectoryName?: string;
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
	private readonly configLoader: (cwd: string, includeProjectConfig: boolean) => ConfigLoadResult;
	private readonly externalWarn?: (message: string) => void;
	private readonly homeDirectory?: string;
	private readonly configDirectoryName?: string;
	private readonly warnings = new Set<string>();
	private readonly tracker: ActivityTracker;
	private showInjectedTime = false;
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
		this.configLoader =
			options.configLoader ??
			((cwd, includeProjectConfig) => loadConfig(cwd, { includeProjectConfig }));
		this.externalWarn = options.warn;
		this.homeDirectory = options.homeDirectory;
		this.configDirectoryName = options.configDirectoryName;
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
		const loaded = this.configLoader(ctx.cwd, ctx.isProjectTrusted());
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

	private notifyInjectedTime(decision: CarrierDecisionV1, ctx: ExtensionContext): void {
		const policy = this.state.anchor?.policy;
		if (!this.showInjectedTime || !policy || !decision.stamp) return;
		const rendered = renderDecision(decision, policy);
		if (rendered) ctx.ui.notify(`Time context injected:\n${rendered}`, "info");
	}

	async onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		this.tracker.reset();
		this.baselinePending = false;
		const loaded = this.configLoader(ctx.cwd);
		this.showInjectedTime = loaded.config.showInjectedTime;
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
			this.notifyInjectedTime(result.decision, ctx);
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
		this.updateWidget(ctx);

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

	private updateWidget(ctx: ExtensionContext): void {
		if (!ctx.hasUI || !this.state.anchor) return;
		const nowMs = readClock(this.clock);
		if (nowMs === undefined) return;
		const policy = resolvePolicy(this.state.anchor, this.state.revisions, nowMs);
		try {
			// Current time lives in the footer status line (bottom of the window).
			if (ctx.mode === "tui") ctx.ui.setStatus("pi-time-context", statusLine(nowMs, this.state.anchor, policy));
		} catch {
			// Status display is best-effort; never break the caller.
		}
	}

	private appendRevision(policy: TimePolicyV1, scope: "project" | "global"): void {
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
			scope,
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

	async handleTimeConfig(args: string, ctx: ExtensionCommandContext): Promise<void> {
		const parsed = parseTimeConfigArgs(args);
		if (!parsed.args) {
			ctx.ui.notify(parsed.error ?? "参数解析失败", "error");
			return;
		}
		const { action, global } = parsed.args;
		const paths = configPaths(ctx.cwd, {
			homeDirectory: this.homeDirectory,
			configDirectoryName: this.configDirectoryName,
		});

		if (action === "show") {
			const nowMs = readClock(this.clock);
			if (!this.state.anchor || nowMs === undefined) {
				ctx.ui.notify("pi-time-context 尚未激活（等待第一条用户消息）");
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
			return;
		}

		const effective = this.currentEffectivePolicy();
		if (!effective) {
			ctx.ui.notify("pi-time-context 尚未激活（等待第一条用户消息），修改将在新会话生效", "warning");
			return;
		}
		const currentConfig: TimeContextConfig = {
			checkpointIntervalMinutes: Math.round(effective.policy.checkpointIntervalMs / 60_000),
			previousActivityThresholdMinutes: Math.round(effective.policy.previousActivityThresholdMs / 60_000),
			timeZone: effective.policy.timeZone,
			stampEveryMessage: effective.policy.stampEveryMessage,
		};
		const scope = global ? "global" : "project";
		const targetPath = global ? paths.globalPath : paths.projectPath;

		let patch: Partial<TimeContextConfig>;
		let nextPolicy: TimePolicyV1;
		if (action === "every") {
			const enabled = !effective.policy.stampEveryMessage;
			patch = { stampEveryMessage: enabled };
			nextPolicy = { ...effective.policy, stampEveryMessage: enabled };
		} else if (action === "interval") {
			const minutes = parsed.args.value !== undefined ? parseIntervalValue(parsed.args.value) : undefined;
			if (minutes === undefined) {
				ctx.ui.notify("间隔必须是 1 到 10080 之间的整数分钟", "error");
				return;
			}
			patch = { checkpointIntervalMinutes: minutes, stampEveryMessage: false };
			nextPolicy = {
				...effective.policy,
				checkpointIntervalMs: minutes * 60_000,
				stampEveryMessage: false,
			};
		} else if (action === "threshold") {
			const minutes = parsed.args.value !== undefined ? parseIntervalValue(parsed.args.value) : undefined;
			if (minutes === undefined) {
				ctx.ui.notify("阈值必须是 1 到 10080 之间的整数分钟", "error");
				return;
			}
			patch = { previousActivityThresholdMinutes: minutes };
			nextPolicy = { ...effective.policy, previousActivityThresholdMs: minutes * 60_000 };
		} else {
			const requested = parsed.args.value ?? "";
			if (!resolveTimeZone(requested)) {
				ctx.ui.notify(`无法识别的时区 “${requested}”（可用 local、UTC 或 IANA 名称）`, "error");
				return;
			}
			patch = { timeZone: requested };
			nextPolicy = { ...effective.policy, timeZone: resolveTimeZone(requested) ?? effective.policy.timeZone };
		}

		try {
			writeConfigLayer(targetPath, patch);
		} catch (error) {
			ctx.ui.notify(`写入 ${targetPath} 失败：${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		this.appendRevision(nextPolicy, scope);
		const summary =
			action === "every"
				? `每条消息附着时间戳：${nextPolicy.stampEveryMessage ? "开" : "关"}`
				: action === "tz"
					? `时区：${nextPolicy.timeZone}`
					: action === "interval"
						? `检查点间隔：${nextPolicy.stampEveryMessage ? "每条消息" : `${Math.round(nextPolicy.checkpointIntervalMs / 60_000)} 分钟`}`
						: `上一活动阈值：${Math.round(nextPolicy.previousActivityThresholdMs / 60_000)} 分钟`;
		ctx.ui.notify(`${summary}（已写入 ${scope === "global" ? "全局" : "项目"}层，对后续消息生效）`);
		this.updateWidget(ctx);
	}
}

export function registerTimeContextExtension(pi: ExtensionAPI, options: RuntimeOptions = {}): TimeContextRuntime {
	const runtime = new TimeContextRuntime(pi, options);
	registerDecisionRenderer(pi);
	pi.registerCommand("time-config", {
		description: "查看/修改 pi-time-context 配置（间隔、阈值、时区、每条消息模式）",
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
