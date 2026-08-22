import { describe, expect, it } from "vitest";
import {
	formatLocalMinute,
	isValidEpochMs,
	readClock,
	resolveTimeZone,
	roundElapsedMinutes,
} from "../src/clock.js";

describe("clock", () => {
	it("formats a fixed minute in the frozen display time zone", () => {
		const value = Date.UTC(2026, 7, 22, 6, 15, 59, 999);
		expect(formatLocalMinute(value, "UTC")).toBe("2026-08-22 06:15");
		expect(formatLocalMinute(value, "Asia/Shanghai")).toBe("2026-08-22 14:15");
	});

	it("resolves supported zones and rejects unsupported zones", () => {
		expect(resolveTimeZone("UTC")).toBe("UTC");
		expect(resolveTimeZone("Not/A_Real_Zone")).toBeUndefined();
		expect(resolveTimeZone("local")).toEqual(expect.any(String));
	});

	it("validates clock reads and rounds only for display", () => {
		expect(isValidEpochMs(Number.NaN)).toBe(false);
		expect(readClock({ now: () => Number.NaN })).toBeUndefined();
		expect(roundElapsedMinutes(30 * 60_000 + 1)).toBe(30);
		expect(roundElapsedMinutes(30 * 60_000 + 30_000)).toBe(31);
	});
});
