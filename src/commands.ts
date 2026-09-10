import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	formatClockMinute,
	formatLocalMinute,
	isValidEpochMs,
	resolveTimeZone,
} from "./clock.js";
import {
	MAX_INTERVAL_MINUTES,
	MIN_INTERVAL_MINUTES,
	type TimeContextConfig,
} from "./config.js";
import { resolvePolicy } from "./policy-revisions.js";
import type {
	CarrierDecisionV1,
	PolicyRevisionV1,
	SessionAnchorV1,
	TimePolicyV1,
} from "./types.js";

export interface GlobalProjectPaths {
	globalPath: string;
	projectPath: string;
}

export function configPaths(cwd: string, options: { homeDirectory?: string; configDirectoryName?: string } = {}): GlobalProjectPaths {
	return {
		globalPath: options.homeDirectory
			? join(options.homeDirectory, ".pi", "agent", "pi-time-context.json")
			: join(getAgentDir(), "pi-time-context.json"),
		projectPath: join(cwd, options.configDirectoryName ?? CONFIG_DIR_NAME, "pi-time-context.json"),
	};
}

export interface ParsedTimeConfigArgs {
	action: "show" | "interval" | "threshold" | "tz" | "every";
	value?: string;
	global: boolean;
}

export interface ParseResult {
	args?: ParsedTimeConfigArgs;
	error?: string;
}

const USAGE = [
	"用法：",
	"  /time-config              交互式配置",
	"  /time-config show         查看当前配置与最近时间戳",
	"  /time-config interval <分钟> [-g]",
	"  /time-config every [-g]   切换“每条消息都附着”模式",
	"  /time-config threshold <分钟> [-g]",
	"  /time-config tz <IANA|local|UTC> [-g]",
].join("\n");

export function parseTimeConfigArgs(input: string): ParseResult {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const globalFlags = tokens.filter((token) => token === "-g" || token === "--global");
	const positional = tokens.filter((token) => token !== "-g" && token !== "--global");
	const unknownFlags = tokens.filter((token) => token.startsWith("-") && !(token === "-g" || token === "--global"));
	if (unknownFlags.length > 0) {
		return { error: `未知参数 ${unknownFlags.join(" ")}\n\n${USAGE}` };
	}
	const action = (positional[0] ?? "show") as ParsedTimeConfigArgs["action"];
	const value = positional[1];
	switch (action) {
		case "show":
		case "every":
			if (value !== undefined) return { error: `${action} 不需要参数\n\n${USAGE}` };
			return { args: { action, global: globalFlags.length > 0 } };
		case "interval":
		case "threshold":
		case "tz":
			if (!value) return { error: `${action} 需要一个参数\n\n${USAGE}` };
			if (positional.length > 2) return { error: `参数过多\n\n${USAGE}` };
			return { args: { action, value, global: globalFlags.length > 0 } };
		default:
			return { error: `未知子命令 “${positional[0]}”\n\n${USAGE}` };
	}
}

export function parseIntervalValue(raw: string): number | undefined {
	const value = Number(raw);
	if (!Number.isInteger(value)) return undefined;
	if (value < MIN_INTERVAL_MINUTES || value > MAX_INTERVAL_MINUTES) return undefined;
	return value;
}

/** Merge a patch into the config file at `path`, creating directories as needed. */
export function writeConfigLayer(
	path: string,
	patch: Partial<TimeContextConfig>,
): void {
	let existing: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			existing = parsed as Record<string, unknown>;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`);
}

export interface TimeDisplayInfo {
	anchor: SessionAnchorV1;
	revisions: readonly PolicyRevisionV1[];
	decisions: readonly CarrierDecisionV1[];
	nowMs: number;
}

function intervalLabel(policy: TimePolicyV1): string {
	return policy.stampEveryMessage
		? "每条消息"
		: `${Math.round(policy.checkpointIntervalMs / 60_000)} 分钟`;
}

export function nextCheckpointAt(nowMs: number, anchor: SessionAnchorV1, policy: TimePolicyV1): number | undefined {
	if (policy.stampEveryMessage) return undefined;
	const interval = policy.checkpointIntervalMs;
	const index = Math.max(0, Math.floor((nowMs - anchor.t0Ms) / interval));
	return anchor.t0Ms + (index + 1) * interval;
}

export function buildShowReport(info: TimeDisplayInfo): string {
	const { anchor, revisions, decisions, nowMs } = info;
	const revision = resolvePolicy(anchor, revisions, nowMs);
	const fromRevision = revision !== anchor.policy;
	const lines: string[] = [
		"pi-time-context 当前生效配置：",
		`  检查点间隔：${intervalLabel(revision)}`,
		`  上一活动阈值：${Math.round(revision.previousActivityThresholdMs / 60_000)} 分钟`,
		`  时区：${revision.timeZone}`,
	];
	const next = nextCheckpointAt(nowMs, anchor, revision);
	lines.push(
		!isValidEpochMs(nowMs)
			? "  下次检查点：时钟无效"
			: next === undefined
				? "  模式：每条消息都附着时间戳"
				: `  下次检查点：${formatClockMinute(next, revision.timeZone)}`,
	);
	lines.push(
		fromRevision
			? `  生效来源：会话内修订（${formatLocalMinute(
					revisions.filter((item) => item.effectiveFromMs <= nowMs).at(-1)?.effectiveFromMs ?? nowMs,
					revision.timeZone,
				)} 起）`
			: "  生效来源：会话锚点（启动时文件配置）",
	);
	const stamped = decisions.filter((decision) => decision.stamp).slice(-5).reverse();
	if (stamped.length > 0) {
		lines.push("最近时间戳：");
		for (const decision of stamped) {
			const elapsed = decision.stamp?.elapsedMinutes;
			lines.push(
				`  ${formatLocalMinute(decision.firstSentAtMs, revision.timeZone)}${
					elapsed !== undefined ? ` · 距上次活动 ${elapsed} 分钟` : ""
				}`,
			);
		}
	}
	return lines.join("\n");
}

export function widgetLines(nowMs: number, anchor: SessionAnchorV1, policy: TimePolicyV1): string[] {
	const lines = [`pi-time-context 现在 ${formatClockMinute(nowMs, policy.timeZone)}`];
	const next = nextCheckpointAt(nowMs, anchor, policy);
	lines.push(
		next === undefined
			? "每条消息附着时间戳"
			: `下次检查点 ${formatClockMinute(next, policy.timeZone)}（间隔 ${Math.round(
					policy.checkpointIntervalMs / 60_000,
				)} 分钟）`,
	);
	return lines;
}
