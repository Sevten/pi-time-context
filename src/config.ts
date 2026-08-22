import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MINUTE_MS, resolveTimeZone } from "./clock.js";
import type { TimePolicyV1, WarningSink } from "./types.js";

export interface TimeContextConfig {
	checkpointIntervalMinutes: number;
	previousActivityThresholdMinutes: number;
	timeZone: string;
}

export interface ConfigLoadResult {
	config: TimeContextConfig;
	warnings: string[];
}

export const DEFAULT_CONFIG: Readonly<TimeContextConfig> = {
	checkpointIntervalMinutes: 30,
	previousActivityThresholdMinutes: 30,
	timeZone: "local",
};

const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 10_080;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isRecord(parsed)) return parsed;
		warnings.push(`${path}: configuration root must be an object`);
	} catch (error) {
		warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return undefined;
}

function applyLayer(
	base: TimeContextConfig,
	layer: Record<string, unknown> | undefined,
	path: string,
	warnings: string[],
): TimeContextConfig {
	if (!layer) return base;
	const next = { ...base };
	for (const key of ["checkpointIntervalMinutes", "previousActivityThresholdMinutes"] as const) {
		const value = layer[key];
		if (value === undefined) continue;
		if (
			typeof value === "number" &&
			Number.isFinite(value) &&
			value >= MIN_INTERVAL_MINUTES &&
			value <= MAX_INTERVAL_MINUTES
		) {
			next[key] = value;
		} else {
			warnings.push(`${path}: ${key} must be a finite number from 1 through 10080`);
		}
	}

	if (layer.timeZone !== undefined) {
		if (typeof layer.timeZone === "string" && resolveTimeZone(layer.timeZone)) {
			next.timeZone = layer.timeZone;
		} else {
			warnings.push(`${path}: timeZone must be local, UTC, or a supported IANA time zone`);
		}
	}
	return next;
}

export function loadConfig(cwd: string, homeDirectory = homedir()): ConfigLoadResult {
	const warnings: string[] = [];
	const globalPath = join(homeDirectory, ".pi", "agent", "pi-time-context.json");
	const projectPath = join(cwd, ".pi", "pi-time-context.json");
	let config = { ...DEFAULT_CONFIG };
	config = applyLayer(config, readConfigFile(globalPath, warnings), globalPath, warnings);
	config = applyLayer(config, readConfigFile(projectPath, warnings), projectPath, warnings);
	return { config, warnings };
}

export function freezePolicy(config: TimeContextConfig, warn?: WarningSink): TimePolicyV1 {
	const timeZone = resolveTimeZone(config.timeZone);
	if (!timeZone) {
		warn?.(`Unable to resolve time zone ${config.timeZone}; using UTC`);
	}
	return {
		checkpointIntervalMs: config.checkpointIntervalMinutes * MINUTE_MS,
		previousActivityThresholdMs: config.previousActivityThresholdMinutes * MINUTE_MS,
		timeZone: timeZone ?? "UTC",
		renderVersion: 1,
	};
}
