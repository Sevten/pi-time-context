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

		const result = loadConfig(cwd, { homeDirectory: home });
		expect(result.config).toEqual({
			checkpointIntervalMinutes: 45,
			previousActivityThresholdMinutes: 15,
			timeZone: "UTC",
			showInjectedTime: true,
			stampEveryMessage: false,
		});
>>>>>>> cc5e27d (Add /time-config command, in-session policy revisions, and stamp-every-message mode)
		expect(result.warnings).toHaveLength(1);
		expect(freezePolicy(result.config)).toEqual({
			checkpointIntervalMs: 45 * 60_000,
			previousActivityThresholdMs: 15 * 60_000,
			timeZone: "UTC",
			stampEveryMessage: false,			renderVersion: 1,
		});
	});

	it("does not read project configuration when project trust is inactive", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-time-context-untrusted-config-"));
		temporaryDirectories.push(root);
		const home = join(root, "home");
		const cwd = join(root, "project");
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await mkdir(join(cwd, ".pi"), { recursive: true });
		await writeFile(
			join(home, ".pi", "agent", "pi-time-context.json"),
			JSON.stringify({ checkpointIntervalMinutes: 45, timeZone: "UTC" }),
		);
		await writeFile(join(cwd, ".pi", "pi-time-context.json"), "not valid JSON");

		const result = loadConfig(cwd, { homeDirectory: home, includeProjectConfig: false });
		expect(result.config).toEqual({
			checkpointIntervalMinutes: 45,
			previousActivityThresholdMinutes: 30,
			timeZone: "UTC",
			stampEveryMessage: false,		});
		expect(result.warnings).toEqual([]);
	});

	it("uses the configured project directory name and warns about unknown fields", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-time-context-custom-dir-"));
		temporaryDirectories.push(root);
		const home = join(root, "home");
		const cwd = join(root, "project");
		await mkdir(join(cwd, ".custom-pi"), { recursive: true });
		await writeFile(
			join(cwd, ".custom-pi", "pi-time-context.json"),
			JSON.stringify({ previousActivityThresholdMinutes: 10, typo: true }),
		);

		const result = loadConfig(cwd, {
			homeDirectory: home,
			configDirectoryName: ".custom-pi",
		});
		expect(result.config.previousActivityThresholdMinutes).toBe(10);
		expect(result.warnings).toEqual([
			`${join(cwd, ".custom-pi", "pi-time-context.json")}: unknown configuration key typo`,
		]);
	});
});
