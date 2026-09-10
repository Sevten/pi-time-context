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

export function globalConfigPath(options: { homeDirectory?: string } = {}): string {
	return options.homeDirectory
		? join(options.homeDirectory, ".pi", "agent", "pi-time-context.json")
		: join(getAgentDir(), "pi-time-context.json");
}

export interface ParsedTimeConfigArgs {
	action: "show" | "interval" | "threshold" | "tz" | "every";
	value?: string;
}

export interface ParseResult {
	args?: ParsedTimeConfigArgs;
	error?: string;
}

export const USAGE = [
	"Usage:",
	"  /time-config              Interactive configuration",
	"  /time-config show         Show current config and recent timestamps",
	"  /time-config interval <minutes>",
	"  /time-config every        Toggle \"stamp every message\" mode",
	"  /time-config threshold <minutes>",
	"  /time-config tz <IANA|local|UTC>",
	"",
	"Settings are stored in the global config (~/.pi/agent/pi-time-context.json).",
].join("\n");

export function parseTimeConfigArgs(input: string): ParseResult {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	const unknownFlags = tokens.filter((token) => token.startsWith("-"));
	if (unknownFlags.length > 0) {
		return { error: `Unknown flag ${unknownFlags.join(" ")}\n\n${USAGE}` };
	}
	const action = (tokens[0] ?? "show") as ParsedTimeConfigArgs["action"];
	const value = tokens[1];
	switch (action) {
		case "show":
		case "every":
			if (value !== undefined) return { error: `${action} takes no arguments\n\n${USAGE}` };
			return { args: { action } };
		case "interval":
		case "threshold":
		case "tz":
			if (!value) return { error: `${action} requires an argument\n\n${USAGE}` };
			if (tokens.length > 2) return { error: `Too many arguments\n\n${USAGE}` };
			return { args: { action, value } };
		default:
			return { error: `Unknown subcommand \"${tokens[0]}\"\n\n${USAGE}` };
	}
}

export function parseIntervalValue(raw: string): number | undefined {
	const value = Number(raw);
	if (!Number.isInteger(value)) return undefined;
	if (value < MIN_INTERVAL_MINUTES || value > MAX_INTERVAL_MINUTES) return undefined;
	return value;
}

/** Merge a patch into the global config file, creating directories as needed. */
export function writeGlobalConfig(
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
					elapsed !== undefined ? ` · user idle for ${elapsed} minutes` : ""
				}`,
			);
		}
	}
	return lines.join("\n");
}

export function buildInactiveShowReport(loadConfig: () => TimeContextConfig): string {
	const config = loadConfig();
	return [
		"pi-time-context is not yet active (waiting for the first user message).",
		"Configuration that will be frozen into the session anchor:",
		`  Checkpoint interval: ${config.checkpointIntervalMinutes} minutes`,
		`  Previous-activity threshold: ${config.previousActivityThresholdMinutes} minutes`,
		`  Time zone: ${config.timeZone}`,
		`  Stamp every message: ${config.stampEveryMessage ? "on" : "off"}`,
	].join("\n");
}


