import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { MINUTE_MS, resolveTimeZone } from "./clock.js";
import type { TimePolicyV1, WarningSink } from "./types.js";

export interface TimeContextConfig {
	checkpointIntervalMinutes: number;
	previousActivityThresholdMinutes: number;
	timeZone: string;
	stampEveryMessage: boolean;
}

export interface ConfigLoadResult {
	config: TimeContextConfig;
	warnings: string[];
}

export interface ConfigLoadOptions {
	homeDirectory?: string;
}

export const DEFAULT_CONFIG: Readonly<TimeContextConfig> = {
	checkpointIntervalMinutes: 10,
	previousActivityThresholdMinutes: 30,
	timeZone: "local",
	stampEveryMessage: false,
};

export const MIN_INTERVAL_MINUTES = 1;
export const MAX_INTERVAL_MINUTES = 10_080;

export function isValidIntervalMinutes(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= MIN_INTERVAL_MINUTES &&
		value <= MAX_INTERVAL_MINUTES
	);
}

const SUPPORTED_CONFIG_KEYS: ReadonlySet<string> = new Set([
	"checkpointIntervalMinutes",
	"previousActivityThresholdMinutes",
	"timeZone",
	"stampEveryMessage",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigFile(path: string, warnings: string[]): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isRecord(parsed)) return parsed;
		warnings.push(`${path}: configuration root must be an object`);
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
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
	for (const key of Object.keys(layer)) {
		if (!SUPPORTED_CONFIG_KEYS.has(key)) warnings.push(`${path}: unknown configuration key ${key}`);
	}
	for (const key of ["checkpointIntervalMinutes", "previousActivityThresholdMinutes"] as const) {
		const value = layer[key];
		if (value === undefined) continue;
		if (isValidIntervalMinutes(value)) {
			next[key] = value;
		} else {
			warnings.push(`${path}: ${key} must be a finite number from 1 through 10080`);
		}
	}

	if (layer.stampEveryMessage !== undefined) {
		if (typeof layer.stampEveryMessage === "boolean") {
			next.stampEveryMessage = layer.stampEveryMessage;
		} else {
			warnings.push(`${path}: stampEveryMessage must be a boolean`);
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

export function loadConfig(options: ConfigLoadOptions = {}): ConfigLoadResult {
	const warnings: string[] = [];
	const globalPath = options.homeDirectory
		? join(options.homeDirectory, ".pi", "agent", "pi-time-context.json")
		: join(getAgentDir(), "pi-time-context.json");
	const config = applyLayer({ ...DEFAULT_CONFIG }, readConfigFile(globalPath, warnings), globalPath, warnings);
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
		stampEveryMessage: config.stampEveryMessage,
	};
}
