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
	"Usage:",
	"  /time-config              Interactive configuration",
	"  /time-config show         Show current config and recent timestamps",
	"  /time-config interval <minutes> [-g]",
	"  /time-config every [-g]   Toggle \"stamp every message\" mode",
	"  /time-config threshold <minutes> [-g]",
	"  /time-config tz <IANA|local|UTC> [-g]",
].join("\n");

export function parseTimeConfigArgs(input: string): ParseResult {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const globalFlags = tokens.filter((token) => token === "-g" || token === "--global");
	const positional = tokens.filter((token) => token !== "-g" && token !== "--global");
	const unknownFlags = tokens.filter((token) => token.startsWith("-") && !(token === "-g" || token === "--global"));
	if (unknownFlags.length > 0) {
		return { error: `Unknown flag ${unknownFlags.join(" ")}\n\n${USAGE}` };
	}
	const action = (positional[0] ?? "show") as ParsedTimeConfigArgs["action"];
	const value = positional[1];
	switch (action) {
		case "show":
		case "every":
			if (value !== undefined) return { error: `${action} takes no arguments\n\n${USAGE}` };
			return { args: { action, global: globalFlags.length > 0 } };
		case "interval":
		case "threshold":
		case "tz":
			if (!value) return { error: `${action} requires an argument\n\n${USAGE}` };
			if (positional.length > 2) return { error: `Too many arguments\n\n${USAGE}` };
			return { args: { action, value, global: globalFlags.length > 0 } };
		default:
			return { error: `Unknown subcommand \"${positional[0]}\"\n\n${USAGE}` };
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
		? "every message"
		: `${Math.round(policy.checkpointIntervalMs / 60_000)} minutes`;
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
		"pi-time-context active configuration:",
		`  Checkpoint interval: ${intervalLabel(revision)}`,
		`  Previous-activity threshold: ${Math.round(revision.previousActivityThresholdMs / 60_000)} minutes`,
		`  Time zone: ${revision.timeZone}`,
	];
	const next = nextCheckpointAt(nowMs, anchor, revision);
	lines.push(
		!isValidEpochMs(nowMs)
			? "  Next checkpoint: invalid clock"
			: next === undefined
				? "  Mode: stamping every message"
				: `  Next checkpoint: ${formatClockMinute(next, revision.timeZone)}`,
	);
	lines.push(
		fromRevision
			? `  Source: in-session revision (since ${formatLocalMinute(
					revisions.filter((item) => item.effectiveFromMs <= nowMs).at(-1)?.effectiveFromMs ?? nowMs,
					revision.timeZone,
				)}`
			: "  Source: session anchor (config at startup)",
	);
	const stamped = decisions.filter((decision) => decision.stamp).slice(-5).reverse();
	if (stamped.length > 0) {
		lines.push("Recent timestamps:");
		for (const decision of stamped) {
			const elapsed = decision.stamp?.elapsedMinutes;
			lines.push(
				`  ${formatLocalMinute(decision.firstSentAtMs, revision.timeZone)}${
					elapsed !== undefined ? ` · idle for ${elapsed} minutes` : ""
				}`,
			);
		}
	}
	return lines.join("\n");
}


