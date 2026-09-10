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
	showReport(): string;
	commit(
		action: MenuKind | "every",
		scope: "project" | "global",
		value: MenuCommitValue,
	): { summary?: string; error?: string };
}

type State = "main" | "interval" | "threshold" | "tz" | "layer" | "input" | "show";

const MAIN_OPTIONS = ["interval", "threshold", "timeZone", "show", "exit"] as const;
const INTERVAL_PRESETS = [5, 10, 15, 30, 60, 120];
const TZ_PRESETS = ["local", "UTC"];
const CUSTOM = "Custom…";
const EVERY = "Every message";

function valueOptions(kind: "interval" | "threshold"): string[] {
	const presets = INTERVAL_PRESETS.map((minutes) => `${minutes} min`);
	return kind === "interval" ? [EVERY, ...presets, CUSTOM] : [...presets, CUSTOM];
}

const TITLES: Record<Exclude<State, "input">, string> = {
	main: "pi-time-context",
	interval: "Checkpoint interval",
	threshold: "Previous-activity threshold",
	tz: "Time zone",
	layer: "Config layer",
	show: "Report (press any key to go back)",
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
	private selectedIndex = 0;
	private pendingKind: MenuKind = "interval";
	private pendingValue: MenuCommitValue = {};
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

	private options(): readonly string[] {
		switch (this.state) {
			case "main":
				return MAIN_OPTIONS;
			case "interval":
			case "threshold":
				return valueOptions(this.state);
			case "tz":
				return [...TZ_PRESETS, CUSTOM];
			case "layer":
				return ["Project", "Global"];
			default:
				return [];
		}
	}

	private summaryLine(): string {
		const interval = this.config.stampEveryMessage
			? "every message"
			: `${this.config.checkpointIntervalMinutes} min`;
		return `interval: ${interval} · threshold: ${this.config.previousActivityThresholdMinutes} min · tz: ${this.config.timeZone}`;
	}

	private hintLine(): string {
		if (this.state === "input") return "enter confirm · esc cancel";
		if (this.state === "show") return "any key back";
		return "↑↓ move · enter select · 1-9 quick pick · esc back";
	}

	render(width: number): string[] {
		const border = "─".repeat(Math.max(1, width));
		const lines: string[] = [border, ""];
		if (this.state === "input") {
			lines.push(truncate(`${TITLES[this.pendingKind]} — custom value`, width));
			lines.push("", `> ${this.inputBuffer}_`);
		} else {
			lines.push(truncate(TITLES[this.state], width));
			if (this.state === "main") lines.push(truncate(this.summaryLine(), width));
			if (this.status) lines.push(truncate(this.status, width));
			lines.push("");
			for (let i = 0; i < this.options().length; i++) {
				const option = this.options()[i];
				lines.push(i === this.selectedIndex ? `→ ${option}` : `  ${option}`);
			}
		}
		lines.push("", truncate(this.hintLine(), width), "", border);
		return lines;
	}

	private move(delta: number): void {
		const count = this.options().length;
		this.selectedIndex = Math.min(count - 1, Math.max(0, this.selectedIndex + delta));
	}

	private commitWith(scope: "project" | "global"): void {
		const action = this.pendingKind === "tz" ? "tz" : this.pendingValue.every ? "every" : this.pendingKind;
		const result = this.deps.commit(action, scope, this.pendingValue);
		this.status = result.error ?? `✓ ${result.summary ?? "done"}`;
		this.config = this.deps.loadConfig();
		this.state = "main";
		this.selectedIndex = 0;
	}

	private confirmValue(choice: string): void {
		if (this.state === "interval" || this.state === "threshold") {
			if (choice === EVERY) {
				this.pendingValue = { every: true };
			} else if (choice !== CUSTOM) {
				const minutes = INTERVAL_PRESETS[this.selectedIndex - (this.state === "interval" ? 1 : 0)];
				this.pendingValue = { minutes };
			} else {
				this.openInput("minutes");
				return;
			}
		} else if (this.state === "tz") {
			if (choice === CUSTOM) {
				this.openInput("tz");
				return;
			}
			this.pendingValue = { timeZone: choice };
		}
		this.state = "layer";
		this.selectedIndex = 0;
	}

	private openInput(mode: "minutes" | "tz"): void {
		this.state = "input";
		this.pendingInputMode = mode;
		this.inputBuffer = "";
	}

	private pendingInputMode: "minutes" | "tz" = "minutes";

	handleInput(data: string): void {
		if (this.state === "show") {
			this.state = "main";
			this.selectedIndex = 0;
			return;
		}
		if (this.state === "input") {
			if (data === "\x1b") {
				this.state = this.pendingKind;
				this.selectedIndex = 0;
				return;
			}
			if (data === "\r" || data === "\n") {
				if (this.pendingInputMode === "minutes") {
					const minutes = parseIntervalValue(this.inputBuffer.trim());
					if (minutes === undefined) {
						this.status = "Interval must be an integer between 1 and 10080 minutes";
						return;
					}
					this.pendingValue = { minutes };
				} else {
					const timeZone = this.inputBuffer.trim();
					if (!resolveTimeZone(timeZone)) {
						this.status = `Unrecognized time zone "${timeZone}"`;
						return;
					}
					this.pendingValue = { timeZone };
				}
				this.state = "layer";
				this.selectedIndex = 0;
				return;
			}
			if (data === "\x7f" || data === "\b") {
				this.inputBuffer = this.inputBuffer.slice(0, -1);
				return;
			}
			if (data.length === 1 && data >= " ") this.inputBuffer += data;
			return;
		}

		if (data === "\x1b") {
			if (this.state === "main") {
				this.close();
				return;
			}
			this.state = "main";
			this.selectedIndex = 0;
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
			if (choice === "interval" || choice === "threshold" || choice === "timeZone") {
				this.pendingKind = choice === "timeZone" ? "tz" : choice;
				this.pendingValue = {};
				this.state = this.pendingKind;
				this.selectedIndex = 0;
			} else if (choice === "show") {
				this.state = "show";
			} else {
				this.close();
			}
			return;
		}
		if (this.state === "interval" || this.state === "threshold" || this.state === "tz") {
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
