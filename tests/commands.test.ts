import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildShowReport,
	configPaths,
	parseIntervalValue,
	parseTimeConfigArgs,
	writeConfigLayer,
} from "../src/commands.js";
import { parsePolicyRevision } from "../src/persistence.js";
import { anchor } from "./helpers.js";

const T0 = 1_700_000_000_000;

describe("parseTimeConfigArgs", () => {
	it("parses subcommands and the global flag", () => {
		expect(parseTimeConfigArgs("")).toEqual({ args: { action: "show", global: false } });
		expect(parseTimeConfigArgs("interval 15 -g")).toEqual({
			args: { action: "interval", value: "15", global: true },
		});
		expect(parseTimeConfigArgs("every --global")).toEqual({
			args: { action: "every", global: true },
		});
		expect(parseTimeConfigArgs("tz Asia/Shanghai")).toEqual({
			args: { action: "tz", value: "Asia/Shanghai", global: false },
		});
	});

	it("rejects unknown actions, missing values, and unknown flags", () => {
		expect(parseTimeConfigArgs("bogus").error).toContain("Unknown subcommand");
		expect(parseTimeConfigArgs("interval").error).toContain("requires an argument");
		expect(parseTimeConfigArgs("interval 15 -x").error).toContain("Unknown flag");
		expect(parseTimeConfigArgs("show 3").error).toContain("takes no arguments");
	});
});

describe("parseIntervalValue", () => {
	it("accepts integers within bounds", () => {
		expect(parseIntervalValue("1")).toBe(1);
		expect(parseIntervalValue("10080")).toBe(10080);
	});
	it("rejects out-of-range and non-integer values", () => {
		expect(parseIntervalValue("0")).toBeUndefined();
		expect(parseIntervalValue("10081")).toBeUndefined();
		expect(parseIntervalValue("1.5")).toBeUndefined();
		expect(parseIntervalValue("abc")).toBeUndefined();
	});
});

describe("writeConfigLayer", () => {
	it("merges into an existing file and creates directories", () => {
		const dir = mkdtempSync(join(tmpdir(), "time-config-"));
		const path = join(dir, "nested", "pi-time-context.json");
		writeConfigLayer(path, { checkpointIntervalMinutes: 15 });
		writeConfigLayer(path, { timeZone: "UTC" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			checkpointIntervalMinutes: 15,
			timeZone: "UTC",
		});

		writeFileSync(path, `${JSON.stringify({ timeZone: "UTC", custom: [1] }, null, 2)}\n`);
		writeConfigLayer(path, { stampEveryMessage: true });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			timeZone: "UTC",
			custom: [1],
			stampEveryMessage: true,
		});
	});
});

describe("configPaths", () => {
	it("derives global and project paths", () => {
		const paths = configPaths("/proj", { homeDirectory: "/home/x", configDirectoryName: ".pi" });
		expect(paths.globalPath).toBe("/home/x/.pi/agent/pi-time-context.json");
		expect(paths.projectPath).toBe("/proj/.pi/pi-time-context.json");
	});
});

describe("buildShowReport and widgetLines", () => {
	const base = anchor(T0);
	const rev = parsePolicyRevision(
		{
			version: 1,
			effectiveFromMs: T0 + 1000,
			policy: { ...base.policy, checkpointIntervalMs: 15 * 60_000 },
			source: "command",
			scope: "project",
		},
		() => {},
	)!;

	it("labels the effective source and shows next checkpoint", () => {
		const report = buildShowReport({ anchor: base, revisions: [rev], decisions: [], nowMs: T0 + 2000 });
		expect(report).toContain("15 minutes");
		expect(report).toContain("in-session revision");
		expect(report).toContain("Next checkpoint");
	});

	it("labels every-message mode", () => {
		const every = parsePolicyRevision(
			{
				version: 1,
				effectiveFromMs: T0 + 1000,
				policy: { ...base.policy, stampEveryMessage: true },
				source: "command",
				scope: "project",
			},
			() => {},
		)!;
		const report = buildShowReport({ anchor: base, revisions: [every], decisions: [], nowMs: T0 + 2000 });
		expect(report).toContain("stamping every message");
	});

});
