import type { Clock } from "./types.js";

export const MINUTE_MS = 60_000;

export const systemClock: Clock = {
	now: () => Date.now(),
};

export function isValidEpochMs(value: number): boolean {
	return Number.isFinite(value) && value >= 0 && value <= 8_640_000_000_000_000;
}

export function readClock(clock: Clock): number | undefined {
	const value = clock.now();
	return isValidEpochMs(value) ? value : undefined;
}

export function resolveTimeZone(configured: string): string | undefined {
	const candidate = configured === "local" ? Intl.DateTimeFormat().resolvedOptions().timeZone : configured;
	if (!candidate) return undefined;
	try {
		new Intl.DateTimeFormat("en-US", { timeZone: candidate }).format(0);
		return candidate;
	} catch {
		return undefined;
	}
}

export function formatLocalMinute(epochMs: number, timeZone: string): string {
	if (!isValidEpochMs(epochMs)) {
		throw new RangeError("Cannot format an invalid epoch timestamp");
	}

	const parts = new Intl.DateTimeFormat("en-US", {
		calendar: "gregory",
		numberingSystem: "latn",
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
		timeZoneName: "longOffset",
	}).formatToParts(epochMs);
	const values = new Map(parts.map((part) => [part.type, part.value]));
	const year = values.get("year");
	const month = values.get("month");
	const day = values.get("day");
	const hour = values.get("hour");
	const minute = values.get("minute");
	const timeZoneName = values.get("timeZoneName");
	if (!year || !month || !day || !hour || !minute || !timeZoneName) {
		throw new RangeError(`Time zone ${timeZone} did not produce complete date parts`);
	}
	const offset = timeZoneName === "GMT" ? "+00:00" : timeZoneName.replace(/^GMT/, "");
	if (!/^[+-]\d{2}:\d{2}$/.test(offset)) {
		throw new RangeError(`Time zone ${timeZone} did not produce a numeric UTC offset`);
	}
	return `${year}-${month}-${day} ${hour}:${minute} ${offset}`;
}

export function roundElapsedMinutes(elapsedMs: number): number {
	return Math.max(0, Math.round(elapsedMs / MINUTE_MS));
}
