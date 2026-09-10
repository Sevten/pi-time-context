import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseIntervalValue } from "./commands.js";
import { resolveTimeZone } from "./clock.js";
import type { TimeContextConfig } from "./config.js";

export type MenuKind = "interval" | "threshold" | "tz";

export interface MenuCommitValue {
	minutes?: number;
	timeZone?: string;
	every?: boolean;
}

export interface MenuTheme {
	fg(color: "dim" | "muted" | "accent" | "text", text: string): string;
	bold(text: string): string;
}

export interface MenuDeps {
	loadConfig(): TimeContextConfig;
	commit(
		action: MenuKind | "every",
		scope: "project" | "global",
		value: MenuCommitValue,
	): { summary?: string; error?: string };
}

type State = "main" | "value" | "layer";

interface MainItem {
	label: string;
	value(): string;
}

const MAIN_ITEMS: readonly MainItem[] = [
	{ label: "Timestamp interval", value: () => "" },
	{ label: "Idle gap threshold", value: () => "" },
	{ label: "Time zone", value: () => "" },
];

const MAIN_KEYS = ["interval", "threshold", "tz"] as const;

const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120];
const TZ_PRESETS = ["local", "UTC"];
const CUSTOM = "Custom";
const EVERY = "Every message";
const LAYER_OPTIONS = ["Project", "Global"] as const;

const SUBTITLES: Record<MenuKind, string> = {
	interval: "Timestamp interval",
	threshold: "Idle gap threshold",
	tz: "Time zone",
};

function stripAnsi(line: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape stripping
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleTruncate(line: string, width: number): string {
	if (stripAnsi(line).length <= width) return line;
	const plain = stripAnsi(line);
	return `${plain.slice(0, Math.max(1, width - 1))}…`;
}

function keyHint(theme: MenuTheme, key: string, description: string): string {
	return theme.fg("dim", key) + theme.fg("muted", ` ${description}`);
}

/**
 * Single-component multi-step configuration menu (same architecture as pi's
 * built-in settings menus): all steps render inside one dialog, so there is
 * no editor restore/flash between steps.
 */
export class TimeConfigMenuComponent {
	private readonly deps: MenuDeps;
	private readonly close: () => void;
	private readonly theme: MenuTheme;
	private state: State = "main";
	private kind: MenuKind = "interval";
	private selectedIndex = 0;
	private pendingValue: MenuCommitValue = {};
	// Inline editing of the "Custom" row.
	private editing = false;
	private inputBuffer = "";
	private status?: string;
	private config: TimeContextConfig;

	constructor(deps: MenuDeps, close: () => void, theme: MenuTheme) {
		this.deps = deps;
		this.close = close;
		this.theme = theme;
		this.config = deps.loadConfig();
	}

	invalidate(): void {
		// no cached state; re-render recomputes everything
	}

	private intervalValue(): string {
		return this.config.stampEveryMessage ? "every message" : `every ${this.config.checkpointIntervalMinutes} min`;
	}

	private mainItems(): { label: string; value: string }[] {
		const tz = resolveTimeZone(this.config.timeZone) ?? this.config.timeZone;
		return [
			{ label: "Timestamp interval", value: this.intervalValue() },
			{ label: "Idle gap threshold", value: `${this.config.previousActivityThresholdMinutes} min` },
			{ label: "Time zone", value: tz },
		];
	}

	private valueOptions(): string[] {
		if (this.kind === "tz") return [...TZ_PRESETS, CUSTOM];
		const presets = INTERVAL_PRESETS.map((minutes) => `${minutes} min`);
		return this.kind === "interval" ? [EVERY, ...presets, CUSTOM] : [...presets, CUSTOM];
	}

	private options(): readonly string[] {
		switch (this.state) {
			case "value":
				return this.valueOptions();
			case "layer":
				return LAYER_OPTIONS;
			default:
				return MAIN_ITEMS.map((item) => item.label);
		}
	}

	private hintLine(): string {
		const t = this.theme;
		if (this.editing) {
			return keyHint(t, "enter", "confirm") + t.fg("muted", "  ·  ") + keyHint(t, "esc", "exit menu");
		}
		return (
			keyHint(t, "enter", "select") +
			t.fg("muted", "  ·  ") +
			keyHint(t, "1-9", "quick pick") +
			t.fg("muted", "  ·  ") +
			keyHint(t, "esc", "back")
		);
	}

	render(width: number): string[] {
		const border = this.theme.fg("dim", "─".repeat(Math.max(1, width)));
		const lines: string[] = [border, ""];
		if (this.state === "main") {
			const items = this.mainItems();
			const labelWidth = Math.max(...items.map((item) => item.label.length)) + 2;
			for (let i = 0; i < items.length; i++) {
				const selected = i === this.selectedIndex;
				const marker = selected ? this.theme.fg("accent", "→ ") : "  ";
				const label = (items[i].label + " ".repeat(labelWidth)).slice(0, labelWidth);
				const labelText = selected ? this.theme.fg("accent", label) : this.theme.fg("text", label);
				lines.push(marker + labelText + this.theme.fg("muted", items[i].value));
			}
			lines.push("");
		} else {
			if (this.state === "value") {
				lines.push(this.theme.bold(this.theme.fg("accent", SUBTITLES[this.kind])));
			}
			if (this.status) lines.push(this.theme.fg("muted", visibleTruncate(this.status, width)));
			lines.push("");
			const options = this.options();
			for (let i = 0; i < options.length; i++) {
				const selected = i === this.selectedIndex;
				const marker = selected ? this.theme.fg("accent", "→ ") : "  ";
				let label = options[i];
				if (this.state === "value" && label === CUSTOM && selected) {
					label = this.editing ? `${CUSTOM}: ${this.inputBuffer}_` : `${CUSTOM}:`;
				}
				const labelText = selected ? this.theme.fg("accent", label) : this.theme.fg("text", label);
				lines.push(marker + labelText);
			}
		}
		lines.push("", visibleTruncate(this.hintLine(), width), "", border);
		return lines;
	}

	private move(delta: number): void {
		const count = this.options().length;
		this.selectedIndex = Math.min(count - 1, Math.max(0, this.selectedIndex + delta));
		this.editing = this.state === "value" && this.options()[this.selectedIndex] === CUSTOM;
		if (this.editing) this.inputBuffer = "";
	}

	private commitWith(scope: "project" | "global"): void {
		const action = this.pendingValue.every ? "every" : this.kind;
		const result = this.deps.commit(action, scope, this.pendingValue);
		this.status = result.error ?? `✓ ${result.summary ?? "done"}`;
		this.config = this.deps.loadConfig();
		this.state = "main";
		this.selectedIndex = 0;
	}

	private confirmValue(choice: string): void {
		if (this.kind === "tz") {
			if (choice === CUSTOM) return; // handled via inline editing
			this.pendingValue = { timeZone: choice };
		} else if (choice === EVERY) {
			this.pendingValue = { every: true };
		} else if (choice === CUSTOM) {
			return; // handled via inline editing
		} else {
			const offset = this.kind === "interval" ? 1 : 0;
			this.pendingValue = { minutes: INTERVAL_PRESETS[this.selectedIndex - offset] };
		}
		this.state = "layer";
		this.selectedIndex = 0;
	}

	private confirmInput(): void {
		const raw = this.inputBuffer.trim();
		if (this.kind === "tz") {
			if (!resolveTimeZone(raw)) {
				this.status = `Unrecognized time zone "${raw}" (IANA name, local, or UTC)`;
				return;
			}
			this.pendingValue = { timeZone: raw };
		} else {
			const minutes = parseIntervalValue(raw);
			if (minutes === undefined) {
				this.status = "Minutes must be an integer between 1 and 10080";
				return;
			}
			this.pendingValue = { minutes };
		}
		this.state = "layer";
		this.selectedIndex = 0;
	}

	handleInput(data: string): void {
		// pi binds ctrl+c to tui.select.cancel alongside escape.
		if (data === "\x03") {
			this.close();
			return;
		}
		if (data === "\x1b") {
			// A single esc exits the menu, even while editing the Custom row.
			if (this.editing || this.state === "main") {
				this.close();
				return;
			}
			this.state = "main";
			this.selectedIndex = 0;
			return;
		}

		// Inline editing of the Custom row in the value list.
		if (this.state === "value" && this.editing) {
			if (data === "\r" || data === "\n") {
				this.confirmInput();
				return;
			}
			if (data === "\x7f" || data === "\b") {
				this.inputBuffer = this.inputBuffer.slice(0, -1);
				return;
			}
			if (data === "\x1b[A" || data === "\x1bOA" || data === "k" || data === "\x1b[B" || data === "\x1bOB" || data === "j") {
				this.editing = false;
				this.inputBuffer = "";
				this.move(data.includes("[A") || data === "\x1bOA" || data === "k" ? -1 : 1);
				return;
			}
			if (data.length === 1 && data >= " ") {
				this.inputBuffer += data;
				return;
			}
			return;
		}

		if (data === "\x1b[A" || data === "\x1bOA" || data === "k") {
			this.move(-1);
			return;
		}
		if (data === "\x1b[B" || data === "\x1bOB" || data === "j") {
			this.move(1);
			return;
		}
		if (data === "\r" || data === "\n") {
			this.confirm();
			return;
		}
		if (/^[1-9]$/.test(data)) {
			const index = Number(data) - 1;
			if (index < this.options().length) {
				this.selectedIndex = index;
				this.confirm();
			}
		}
	}

	private confirm(): void {
		const choice = this.options()[this.selectedIndex];
		if (choice === undefined) return;
		if (this.state === "main") {
			const item = MAIN_ITEMS[this.selectedIndex];
			this.kind = MAIN_KEYS[MAIN_ITEMS.indexOf(item)];
			this.pendingValue = {};
			this.state = "value";
			this.selectedIndex = 0;
			this.editing = false;
			return;
		}
		if (this.state === "value") {
			if (choice === CUSTOM) {
				this.editing = true;
				this.inputBuffer = "";
				return;
			}
			this.confirmValue(choice);
			return;
		}
		if (this.state === "layer") {
			this.commitWith(choice === "Global" ? "global" : "project");
		}
	}
}

export function runTimeConfigMenu(ctx: ExtensionCommandContext, deps: MenuDeps): Promise<void> {
	return ctx.ui.custom<null>(
		(_tui, theme, _keybindings, done) =>
			new TimeConfigMenuComponent(deps, () => done(null), theme as unknown as MenuTheme),
	).then(() => undefined);
}
