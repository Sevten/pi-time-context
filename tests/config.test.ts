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
	it("applies global config values and rejects invalid overrides", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-time-context-config-"));
		temporaryDirectories.push(root);
		const home = join(root, "home");
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(
			join(home, ".pi", "agent", "pi-time-context.json"),
			JSON.stringify({ checkpointIntervalMinutes: 45, timeZone: "UTC", stampEveryMessage: true }),
		);

		const result = loadConfig({ homeDirectory: home });
		expect(result.config).toEqual({
			checkpointIntervalMinutes: 45,
			previousActivityThresholdMinutes: 30,
			timeZone: "UTC",
			stampEveryMessage: true,
		});
		expect(result.warnings).toEqual([]);
		expect(freezePolicy(result.config)).toEqual({
			checkpointIntervalMs: 45 * 60_000,
			previousActivityThresholdMs: 30 * 60_000,
			timeZone: "UTC",
			stampEveryMessage: true,
			renderVersion: 1,
		});
	});

	it("rejects invalid values with warnings", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-time-context-invalid-config-"));
		temporaryDirectories.push(root);
		const home = join(root, "home");
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(
			join(home, ".pi", "agent", "pi-time-context.json"),
			JSON.stringify({ checkpointIntervalMinutes: 0, previousActivityThresholdMinutes: 15 }),
		);

		const result = loadConfig({ homeDirectory: home });
		expect(result.config.previousActivityThresholdMinutes).toBe(15);
		expect(result.warnings).toHaveLength(1);
	});

	it("warns about unknown fields", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-time-context-unknown-config-"));
		temporaryDirectories.push(root);
		const home = join(root, "home");
		await mkdir(join(home, ".pi", "agent"), { recursive: true });
		await writeFile(
			join(home, ".pi", "agent", "pi-time-context.json"),
			JSON.stringify({ previousActivityThresholdMinutes: 10, typo: true }),
		);

		const result = loadConfig({ homeDirectory: home });
		expect(result.config.previousActivityThresholdMinutes).toBe(10);
		expect(result.warnings).toEqual([
			`${join(home, ".pi", "agent", "pi-time-context.json")}: unknown configuration key typo`,
		]);
	});
});
