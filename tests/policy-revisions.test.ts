import { describe, expect, it } from "vitest";
import { parsePolicyRevision } from "../src/persistence.js";
import { normalizeRevisions, resolvePolicy } from "../src/policy-revisions.js";
import { anchor } from "./helpers.js";

const T0 = 1_000_000;

function revision(effectiveFromMs: number, patch: Partial<{ interval: number; tz: string; every: boolean }> = {}) {
	return parsePolicyRevision(
		{
			version: 1,
			effectiveFromMs,
			policy: {
				checkpointIntervalMs: (patch.interval !== undefined ? patch.interval * 60_000 : 30 * 60_000),
				previousActivityThresholdMs: 30 * 60_000,
				timeZone: patch.tz ?? "UTC",
				renderVersion: 1,
				stampEveryMessage: patch.every ?? false,
			},
			source: "command",
			scope: "project",
		},
		() => {},
	);
}

describe("resolvePolicy", () => {
	it("returns the anchor policy before any revision", () => {
		const base = anchor(T0);
		expect(resolvePolicy(base, [revision(T0 + 100)!], T0)).toEqual(base.policy);
	});

	it("returns the latest revision effective at the given time", () => {
		const base = anchor(T0);
		const revisions = [revision(T0 + 100, { interval: 15 })!, revision(T0 + 200, { interval: 5 })!];
		expect(resolvePolicy(base, revisions, T0 + 150).checkpointIntervalMs).toBe(15 * 60_000);
		expect(resolvePolicy(base, revisions, T0 + 200).checkpointIntervalMs).toBe(5 * 60_000);
		expect(resolvePolicy(base, revisions, T0 + 10_000).checkpointIntervalMs).toBe(5 * 60_000);
	});

	it("ignores revisions dated before the anchor and unsorted input", () => {
		const base = anchor(T0);
		const revisions = normalizeRevisions([revision(T0 + 300, { tz: "Asia/Shanghai" })!, revision(T0 - 5, { tz: "UTC" })!]);
		expect(resolvePolicy(base, revisions, T0 + 300).timeZone).toBe("Asia/Shanghai");
		expect(resolvePolicy(base, [revision(T0 - 5, { tz: "UTC" })!], T0 + 100)).toEqual(base.policy);
	});
});

describe("parsePolicyRevision", () => {
	it("defaults stampEveryMessage to false when absent", () => {
		const parsed = parsePolicyRevision(
			{
				version: 1,
				effectiveFromMs: T0,
				policy: {
					checkpointIntervalMs: 60_000,
					previousActivityThresholdMs: 60_000,
					timeZone: "UTC",
					renderVersion: 1,
				},
				source: "command",
				scope: "global",
			},
			() => {},
		);
		expect(parsed?.policy.stampEveryMessage).toBe(false);
	});

	it("rejects malformed revisions", () => {
		const warn: string[] = [];
		expect(parsePolicyRevision({ version: 1 }, (m) => warn.push(m))).toBeUndefined();
		expect(
			parsePolicyRevision(
				{
					version: 1,
					effectiveFromMs: "nope",
					policy: { checkpointIntervalMs: 1, previousActivityThresholdMs: 1, timeZone: "UTC", renderVersion: 1 },
					source: "command",
					scope: "project",
				},
				(m) => warn.push(m),
			),
		).toBeUndefined();
		expect(warn.length).toBeGreaterThanOrEqual(2);
	});
});
