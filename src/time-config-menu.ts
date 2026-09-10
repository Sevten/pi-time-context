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

export interface MenuDeps {
	loadConfig(): TimeContextConfig;
	commit(
		action: MenuKind | "every",
		scope: "project" | "global",
		value: MenuCommitValue,
	): { summary?: string; error?: string };
}

type State = "main" | "value" | "layer";

const MAIN_OPTIONS = [
	"Checkpoint interval",
	"Previous-activity gap",
	"Time zone",
	"Exit",
] as const;
const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120];
const TZ_PRESETS = ["local", "UTC"];
const CUSTOM = "Custom:";
const EVERY = "Every message";
const LAYER_OPTIONS = ["Project", "Global"] as const;

const SUBTITLES: Record<MenuKind, string> = {
	interval: "Checkpoint interval — pick a value",
	threshold: "Previous-activity gap — pick a value",
	tz: "Time zone — pick a value",
};

function truncate(line: string, width: number): string {
	if (line.length <= width) return line;
	return `${line.slice(0, Math.max(1, width - 1))}…`;
}

/**
 * Single-component multi-step configuration menu (same architecture as pi's
 * built-in settings menus): all steps render inside one dialog, so there is
 * no editor restore/flash between steps.
 */
export class TimeConfigMenuComponent {
	private readonly deps: MenuDeps;
	private readonly close: () => void;
	private state: State = "main";
	private kind: MenuKind = "interval";
	private selectedIndex = 0;
	private pendingValue: MenuCommitValue = {};
	// Inline editing of the "Custom:" row, or of the full-screen input state.
	private editing = false;
	private inputBuffer = "";
	private status?: string;
	private config: TimeContextConfig;

	constructor(deps: MenuDeps, close: () => void) {
		this.deps = deps;
		this.close = close;
		this.config = deps.loadConfig();
	}

	invalidate(): void {
		// no cached state; re-render recomputes everything
	}

	private valueOptions(): string[] {
		if (this.kind === "tz") return [...TZ_PRESETS, CUSTOM];
		const presets = INTERVAL_PRESETS.map((minutes) => `${minutes} min`);
		return this.kind === "interval" ? [EVERY, ...presets, CUSTOM] : [...presets, CUSTOM];
	}

	private options(): readonly string[] {
		switch (this.state) {
			case "main":
				return MAIN_OPTIONS;
			case "value":
				return this.valueOptions();
			case "layer":
				return LAYER_OPTIONS;
			default:
				return [];
		}
	}

	private summaryLines(): string[] {
		const tz = resolveTimeZone(this.config.timeZone) ?? this.config.timeZone;
		return [
			this.config.stampEveryMessage
				? "Timestamps: added to every message"
				: `Timestamps: added after each ${this.config.checkpointIntervalMinutes} min checkpoint`,
			`Idle gap shown after ${this.config.previousActivityThresholdMinutes} min without activity`,
			`Times shown in ${tz}`,
		];
	}

	private hintLine(): string {
		if (this.editing) return "enter confirm · esc stop editing · ↑↓ move";
		return "↑↓ move · enter select · 1-9 quick pick · esc back";
	}

	render(width: number): string[] {
		const border = "─".repeat(Math.max(1, width));
		const lines: string[] = [border, ""];
		{
			if (this.state === "main") {
				for (const line of this.summaryLines()) lines.push(truncate(line, width));
				lines.push("");
			} else if (this.state === "value") {
				lines.push(truncate(SUBTITLES[this.kind], width));
			}
			if (this.status) lines.push(truncate(this.status, width));
			lines.push("");
			const options = this.options();
			for (let i = 0; i < options.length; i++) {
				const selected = i === this.selectedIndex;
				let label = options[i];
				if (this.state === "value" && label === CUSTOM && (selected || this.inputBuffer)) {
					label = `${CUSTOM} ${this.editing ? `${this.inputBuffer}_` : this.inputBuffer || "…"}`;
				}
				lines.push(selected ? `→ ${label}` : `  ${label}`);
			}
		}
		lines.push("", truncate(this.hintLine(), width), "", border);
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
		if (data === "\x1b") {
			if (this.editing) {
				this.editing = false;
				this.inputBuffer = "";
				return;
			}
			if (this.state === "main") {
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
			if (choice === "Exit") {
				this.close();
				return;
			}
			this.kind = choice === "Checkpoint interval" ? "interval" : choice === "Time zone" ? "tz" : "threshold";
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
	return ctx.ui.custom<null>((_tui, _theme, _keybindings, done) => new TimeConfigMenuComponent(deps, () => done(null))).then(() => undefined);
}
