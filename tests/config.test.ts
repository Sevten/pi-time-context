import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freezePolicy, loadConfig } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) {
		await rm(directory, { recursive: true, force: true });
	}
});

describe("configuration", () => {
	it("merges project values over global values and rejects invalid overrides", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-time-context-config-"));
		temporaryDirectories.push(root);
		const home = join(root, "home");
		const cwd = join(root, "project");
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(home, ".pi", "agent", "pi-time-context.json"),
			JSON.stringify({ checkpointIntervalMinutes: 45, timeZone: "UTC", showInjectedTime: true }),
		);
		await writeFile(
			join(cwd, ".pi", "pi-time-context.json"),
			JSON.stringify({ checkpointIntervalMinutes: 0, previousActivityThresholdMinutes: 15 }),
		);

		const result = loadConfig(cwd, home);
		expect(result.config).toEqual({
			checkpointIntervalMinutes: 45,
			previousActivityThresholdMinutes: 15,
			timeZone: "UTC",
			showInjectedTime: true,
		});
		expect(result.warnings).toHaveLength(1);
			expect(freezePolicy(result.config)).toEqual({
			checkpointIntervalMs: 45 * 60_000,
			previousActivityThresholdMs: 15 * 60_000,
			timeZone: "UTC",
			renderVersion: 1,
		});
	});
});
