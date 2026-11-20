import { describe, expect, it } from "vitest";
import { TimeConfigMenuComponent, type MenuCommitValue, type MenuDeps, type MenuTheme } from "../src/time-config-menu.js";
import type { TimeContextConfig } from "../src/config.js";

const theme: MenuTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function strip(lines: readonly string[]): string[] {
	return lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ""));
}

interface Harness {
	component: TimeConfigMenuComponent;
	commits: { kind: string; value: MenuCommitValue }[];
	config: { stampEveryMessage: boolean; checkpointIntervalMinutes: number; previousActivityThresholdMinutes: number; timeZone: string };
	setStatus: (summary?: string, error?: string) => void;
}

function make(overrides?: Partial<TimeContextConfig>): Harness {
	const config = {
		stampEveryMessage: false,
		checkpointIntervalMinutes: 10,
		previousActivityThresholdMinutes: 30,
		timeZone: "local",
		...overrides,
	};
	const commits: { kind: string; value: MenuCommitValue }[] = [];
	let next: { summary?: string; error?: string } = { summary: "done" };
	const deps: MenuDeps = {
		loadConfig: () => ({ ...config }),
		commit: (kind, value) => {
			commits.push({ kind, value });
			return next;
		},
	};
	return {
		component: new TimeConfigMenuComponent(deps, () => {}, theme),
		commits,
		config,
		setStatus: (summary, error) => {
			next = { summary, error };
		},
	};
}

function openMenu(h: Harness, kind: "interval" | "threshold" | "tz"): void {
	// Main list order is interval, threshold, tz.
	const index = kind === "interval" ? 0 : kind === "threshold" ? 1 : 2;
	for (let i = 0; i < index; i++) h.component.handleInput("\x1b[B");
	h.component.handleInput("\r");
}

describe("TimeConfigMenuComponent — main list", () => {
	it("renders the three main items with current config values", () => {
		const h = make();
		const lines = strip(h.component.render(60));
		expect(lines.join("\n")).toContain("Stamp a timestamp every");
		expect(lines.join("\n")).toContain("10 min");
		expect(lines.join("\n")).toContain("30 min idle");
	});

	it("shows 'message' when stamping every message", () => {
		const h = make({ stampEveryMessage: true });
		expect(strip(h.component.render(60)).join("\n")).toContain("message");
	});

	it("enter on a main row opens the value list for that kind", () => {
		const h = make();
		openMenu(h, "threshold");
		const lines = strip(h.component.render(60));
		expect(lines.join("\n")).toContain("Show idle gap after");
		expect(lines.join("\n")).toContain("5 min");
		expect(h.commits).toHaveLength(0);
	});

	it("esc at the top level closes the menu", () => {
		let closed = false;
		const config = { stampEveryMessage: false, checkpointIntervalMinutes: 10, previousActivityThresholdMinutes: 30, timeZone: "local" };
		const deps: MenuDeps = { loadConfig: () => ({ ...config }), commit: () => ({}) };
		const component = new TimeConfigMenuComponent(deps, () => {
			closed = true;
		}, theme);
		component.handleInput("\x1b");
		expect(closed).toBe(true);
	});
});

describe("TimeConfigMenuComponent — interval presets", () => {
	it("commits a preset interval", () => {
		const h = make();
		openMenu(h, "interval");
		// Options: Every message, 5, 10, 15, 30, 60, 120, Custom → pick "15 min" (index 3).
		h.component.handleInput("\x1b[B");
		h.component.handleInput("\x1b[B");
		h.component.handleInput("\x1b[B");
		h.component.handleInput("\r");
		expect(h.commits).toEqual([{ kind: "interval", value: { minutes: 15 } }]);
	});

	it("commits every-message mode", () => {
		const h = make();
		openMenu(h, "interval");
		h.component.handleInput("\r");
		expect(h.commits).toEqual([{ kind: "interval", value: { every: true } }]);
	});

	it("returns to the main list after a commit and reloads config", () => {
		const h = make();
		openMenu(h, "interval");
		h.component.handleInput("\r");
		const lines = strip(h.component.render(60));
		expect(lines.join("\n")).toContain("Stamp a timestamp every");
		expect(lines.join("\n")).toContain("✓ done");
	});

	it("shows an error status when commit fails", () => {
		const h = make();
		h.setStatus(undefined, "boom");
		openMenu(h, "interval");
		h.component.handleInput("\r");
		expect(strip(h.component.render(60)).join("\n")).toContain("boom");
	});
});

describe("TimeConfigMenuComponent — threshold presets", () => {
	it("commits a preset threshold (no Every row)", () => {
		const h = make();
		openMenu(h, "threshold");
		// Options: 5, 10, 15, 30, 60, 120, Custom → pick "5 min" (index 0).
		h.component.handleInput("\r");
		expect(h.commits).toEqual([{ kind: "threshold", value: { minutes: 5 } }]);
	});
});

describe("TimeConfigMenuComponent — time zone", () => {
	it("commits a preset zone", () => {
		const h = make();
		openMenu(h, "tz");
		// Options: local, UTC, Custom → pick UTC (index 1).
		h.component.handleInput("\x1b[B");
		h.component.handleInput("\r");
		expect(h.commits).toEqual([{ kind: "tz", value: { timeZone: "UTC" } }]);
	});
});

describe("TimeConfigMenuComponent — Custom inline editing", () => {
	it("types a custom interval and commits on enter", () => {
		const h = make();
		openMenu(h, "interval");
		// Move to the last row (Custom).
		for (let i = 0; i < 7; i++) h.component.handleInput("\x1b[B");
		h.component.handleInput("\r"); // start editing
		for (const ch of "45") h.component.handleInput(ch);
		h.component.handleInput("\r");
		expect(h.commits).toEqual([{ kind: "interval", value: { minutes: 45 } }]);
	});

	it("rejects an invalid custom interval without committing", () => {
		const h = make();
		openMenu(h, "interval");
		for (let i = 0; i < 7; i++) h.component.handleInput("\x1b[B");
		h.component.handleInput("\r");
		for (const ch of "0") h.component.handleInput(ch);
		h.component.handleInput("\r");
		expect(h.commits).toHaveLength(0);
		// Invalid input keeps the value list open (the error status is only
		// rendered once the user returns to the main list).
		expect(strip(h.component.render(60)).join("\n")).toContain("Every message");
	});

	it("rejects an unrecognized custom time zone without committing", () => {
		const h = make();
		openMenu(h, "tz");
		h.component.handleInput("\x1b[B");
		h.component.handleInput("\x1b[B");
		h.component.handleInput("\r");
		for (const ch of "Mars/Olympus") h.component.handleInput(ch);
		h.component.handleInput("\r");
		expect(h.commits).toHaveLength(0);
		expect(strip(h.component.render(60)).join("\n")).toContain("local");
	});

	it("renders the buffered input while editing Custom", () => {
		const h = make();
		openMenu(h, "interval");
		for (let i = 0; i < 7; i++) h.component.handleInput("\x1b[B");
		h.component.handleInput("\r");
		for (const ch of "9") h.component.handleInput(ch);
		expect(strip(h.component.render(60)).join("\n")).toContain("Custom: 9_");
	});

	it("backspace removes the last typed character", () => {
		const h = make();
		openMenu(h, "interval");
		for (let i = 0; i < 7; i++) h.component.handleInput("\x1b[B");
		h.component.handleInput("\r");
		for (const ch of "12") h.component.handleInput(ch);
		h.component.handleInput("\x7f");
		expect(strip(h.component.render(60)).join("\n")).toContain("Custom: 1_");
	});

	it("esc while editing cancels editing, second esc exits the value list", () => {
		const h = make();
		openMenu(h, "interval");
		for (let i = 0; i < 7; i++) h.component.handleInput("\x1b[B");
		h.component.handleInput("\r");
		h.component.handleInput("7");
		const before = strip(h.component.render(60)).join("\n");
		expect(before).toContain("Custom: 7");
		h.component.handleInput("\x1b"); // cancels editing AND returns to the main list
		expect(strip(h.component.render(60)).join("\n")).toContain("Stamp a timestamp every");
		expect(strip(h.component.render(60)).join("\n")).toContain("Stamp a timestamp every");
		expect(h.commits).toHaveLength(0);
	});

	it("arrow keys while editing leave the Custom row", () => {
		const h = make();
		openMenu(h, "interval");
		for (let i = 0; i < 7; i++) h.component.handleInput("\x1b[B");
		h.component.handleInput("\r");
		h.component.handleInput("\x1b[A"); // move up out of editing
		h.component.handleInput("\r"); // commit "120 min" (index 6)
		expect(h.commits).toEqual([{ kind: "interval", value: { minutes: 120 } }]);
	});

	it("ctrl+c closes the menu", () => {
		let closed = false;
		const config = { stampEveryMessage: false, checkpointIntervalMinutes: 10, previousActivityThresholdMinutes: 30, timeZone: "local" };
		const deps: MenuDeps = { loadConfig: () => ({ ...config }), commit: () => ({}) };
		const component = new TimeConfigMenuComponent(deps, () => {
			closed = true;
		}, theme);
		component.handleInput("\x03");
		expect(closed).toBe(true);
	});
});
