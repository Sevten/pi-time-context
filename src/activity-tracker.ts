import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import { readClock } from "./clock.js";
import type { AgentMessage, AssistantMessageEvent } from "./pi-types.js";
import { isSessionMessageEntry } from "./state.js";
import type { ActivityV1, Clock, WarningSink } from "./types.js";

interface UserCapture {
	timestamp: number;
	processedAtMs: number;
}

interface AssistantCapture {
	timestamp: number;
	requestedAtMs?: number;
	streamStartedAtMs?: number;
	firstContentAtMs?: number;
	completedAtMs?: number;
}

interface ToolCapture {
	toolCallId: string;
	startedAtMs: number;
	completedAtMs?: number;
	isError?: boolean;
}

function findMessageEntry(
	entries: readonly SessionMessageEntry[],
	role: "user" | "assistant",
	timestamp: number,
	claimedIds: ReadonlySet<string>,
): SessionMessageEntry | undefined {
	return entries.find(
		(entry) =>
			!claimedIds.has(entry.id) && entry.message.role === role && entry.message.timestamp === timestamp,
	);
}

function hasAssistantContent(message: AgentMessage): boolean {
	if (message.role !== "assistant") return false;
	return message.content.some((block) => {
		if (block.type === "text") return block.text.length > 0;
		if (block.type === "thinking") return block.thinking.length > 0;
		return block.type === "toolCall";
	});
}

export class ActivityTracker {
	private readonly clock: Clock;
	private readonly warn?: WarningSink;
	private readonly requestedAtQueue: number[] = [];
	private readonly users: UserCapture[] = [];
	private readonly assistants: AssistantCapture[] = [];
	private readonly tools = new Map<string, ToolCapture>();
	private activeAssistant?: AssistantCapture;

	constructor(clock: Clock, warn?: WarningSink) {
		this.clock = clock;
		this.warn = warn;
	}

	reset(): void {
		this.requestedAtQueue.length = 0;
		this.users.length = 0;
		this.assistants.length = 0;
		this.tools.clear();
		this.activeAssistant = undefined;
	}

	noteContextRequest(requestedAtMs: number | undefined): void {
		if (requestedAtMs !== undefined) this.requestedAtQueue.push(requestedAtMs);
	}

	onMessageStart(message: AgentMessage): void {
		if (message.role !== "assistant") return;
		const streamStartedAtMs = readClock(this.clock);
		if (streamStartedAtMs === undefined) this.warn?.("Clock returned an invalid assistant stream start time");
		this.activeAssistant = {
			timestamp: message.timestamp,
			requestedAtMs: this.requestedAtQueue.shift(),
			streamStartedAtMs,
		};
	}

	onMessageUpdate(message: AgentMessage, _event: AssistantMessageEvent): void {
		if (!this.activeAssistant || this.activeAssistant.firstContentAtMs !== undefined) return;
		if (message.role !== "assistant" || message.timestamp !== this.activeAssistant.timestamp) return;
		if (!hasAssistantContent(message)) return;
		const firstContentAtMs = readClock(this.clock);
		if (firstContentAtMs === undefined) {
			this.warn?.("Clock returned an invalid first assistant content time");
			return;
		}
		this.activeAssistant.firstContentAtMs = firstContentAtMs;
	}

	onMessageEnd(message: AgentMessage): number | undefined {
		if (message.role !== "user" && message.role !== "assistant") return undefined;
		const completedAtMs = readClock(this.clock);
		if (completedAtMs === undefined) {
			this.warn?.(`Clock returned an invalid ${message.role} completion time`);
			return undefined;
		}
		if (message.role === "user") {
			this.users.push({ timestamp: message.timestamp, processedAtMs: completedAtMs });
			return completedAtMs;
		}
		if (message.role === "assistant") {
			let capture: AssistantCapture;
			if (this.activeAssistant && this.activeAssistant.timestamp === message.timestamp) {
				capture = this.activeAssistant;
			} else {
				capture = {
					timestamp: message.timestamp,
					requestedAtMs: this.requestedAtQueue.shift(),
					streamStartedAtMs: completedAtMs,
				};
			}
			capture.completedAtMs = completedAtMs;
			this.assistants.push(capture);
			this.activeAssistant = undefined;
		}
		return completedAtMs;
	}

	onToolStart(toolCallId: string): void {
		const startedAtMs = readClock(this.clock);
		if (startedAtMs === undefined) {
			this.warn?.("Clock returned an invalid tool start time");
			return;
		}
		this.tools.set(toolCallId, { toolCallId, startedAtMs });
	}

	onToolEnd(toolCallId: string, isError: boolean): void {
		const completedAtMs = readClock(this.clock);
		const capture = this.tools.get(toolCallId);
		if (!capture) {
			this.warn?.(`Ignoring tool completion without a matching start: ${toolCallId}`);
			return;
		}
		if (completedAtMs === undefined) {
			this.warn?.("Clock returned an invalid tool completion time");
			return;
		}
		capture.completedAtMs = completedAtMs;
		capture.isError = isError;
	}

	resolveActivities(branch: readonly SessionEntry[], existing: ReadonlyMap<string, ActivityV1>): ActivityV1[] {
		const entries = branch.filter(isSessionMessageEntry);
		const claimedIds = new Set<string>();
		for (const activity of existing.values()) {
			if (activity.kind !== "tool") claimedIds.add(activity.messageEntryId);
		}
		const resolved: ActivityV1[] = [];

		for (let index = 0; index < this.users.length; ) {
			const capture = this.users[index];
			if (!capture) break;
			const entry = findMessageEntry(entries, "user", capture.timestamp, claimedIds);
			if (!entry) {
				index++;
				continue;
			}
			const activity: ActivityV1 = {
				key: `user:${entry.id}`,
				kind: "user",
				messageEntryId: entry.id,
				processedAtMs: capture.processedAtMs,
			};
			claimedIds.add(entry.id);
			if (!existing.has(activity.key)) resolved.push(activity);
			this.users.splice(index, 1);
		}

		for (let index = 0; index < this.assistants.length; ) {
			const capture = this.assistants[index];
			if (!capture) break;
			const entry = findMessageEntry(entries, "assistant", capture.timestamp, claimedIds);
			if (!entry || capture.completedAtMs === undefined) {
				index++;
				continue;
			}
			const activity: ActivityV1 = {
				key: `assistant:${entry.id}`,
				kind: "assistant",
				messageEntryId: entry.id,
				requestedAtMs: capture.requestedAtMs,
				streamStartedAtMs: capture.streamStartedAtMs,
				firstContentAtMs: capture.firstContentAtMs,
				completedAtMs: capture.completedAtMs,
			};
			claimedIds.add(entry.id);
			if (!existing.has(activity.key)) resolved.push(activity);
			this.assistants.splice(index, 1);
		}

		for (const [toolCallId, capture] of this.tools) {
			if (capture.completedAtMs === undefined || capture.isError === undefined) continue;
			const key = `tool:${toolCallId}`;
			const toolResultEntry = entries.find(
				(entry) => entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId,
			);
			if (!existing.has(key)) {
				resolved.push({
					key,
					kind: "tool",
					toolCallId,
					toolResultEntryId: toolResultEntry?.id,
					startedAtMs: capture.startedAtMs,
					completedAtMs: capture.completedAtMs,
					isError: capture.isError,
				});
			}
			this.tools.delete(toolCallId);
		}
		return resolved;
	}
}
