import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "../src/pi-types.js";
import type { Clock, SessionAnchorV1 } from "../src/types.js";

export class MutableClock implements Clock {
	value: number;

	constructor(value: number) {
		this.value = value;
	}

	now(): number {
		return this.value;
	}
}

export function anchor(t0Ms = 0): SessionAnchorV1 {
	return {
		version: 1,
		t0Ms,
		origin: "first_user_processed",
		policy: {
			checkpointIntervalMs: 30 * 60_000,
			previousActivityThresholdMs: 30 * 60_000,
			timeZone: "UTC",
			renderVersion: 1,
		},
	};
}

export function user(timestamp: number, text = "hello"): AgentMessage {
	return { role: "user", content: text, timestamp };
}

export function assistant(timestamp: number, text = "done"): AgentMessage {
	return {
		role: "assistant",
		content: text ? [{ type: "text", text }] : [],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

export function assistantWithTools(timestamp: number, toolCallIds: readonly string[]): AgentMessage {
	const message = assistant(timestamp, "");
	if (message.role !== "assistant") throw new Error("Expected assistant message");
	return {
		...message,
		content: toolCallIds.map((id) => ({ type: "toolCall", id, name: "test", arguments: {} })),
		stopReason: "toolUse",
	};
}

export function toolResult(timestamp: number, toolCallId: string, text = "result"): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "test",
		content: [{ type: "text", text }],
		isError: false,
		timestamp,
	};
}

export function messageEntry(
	id: string,
	parentId: string | null,
	message: AgentMessage,
): SessionMessageEntry {
	return { type: "message", id, parentId, timestamp: new Date(0).toISOString(), message };
}

export function customEntry(
	id: string,
	parentId: string | null,
	customType: string,
	data: unknown,
): SessionEntry {
	return {
		type: "custom",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		customType,
		data,
	};
}
