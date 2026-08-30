import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionMessageEntry,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { TimeContextRuntime, type RuntimeOptions } from "../src/index.js";
import type { AgentMessage, MessageEndEvent } from "../src/pi-types.js";
import {
	ACTIVITY_FACTS_ENTRY,
	CARRIER_DECISION_ENTRY,
	SESSION_ANCHOR_ENTRY,
	type ActivityFactsV1,
	type CarrierDecisionV1,
	type SessionAnchorV1,
} from "../src/types.js";
import { assistant, assistantWithTools, MutableClock, toolResult, user } from "./helpers.js";

class MockSession {
	readonly entries: SessionEntry[] = [];
	private nextCustomId = 1;

	appendMessage(id: string, message: AgentMessage): SessionMessageEntry {
		const entry: SessionMessageEntry = {
			type: "message",
			id,
			parentId: this.entries.at(-1)?.id ?? null,
			timestamp: new Date(message.timestamp).toISOString(),
			message,
		};
		this.entries.push(entry);
		return entry;
	}

	appendCustom(customType: string, data: unknown): void {
		this.entries.push({
			type: "custom",
			id: `custom-${this.nextCustomId++}`,
			parentId: this.entries.at(-1)?.id ?? null,
			timestamp: new Date(0).toISOString(),
			customType,
			data,
		});
	}

	getEntries(): SessionEntry[] {
		return [...this.entries];
	}

	getBranch(): SessionEntry[] {
		return [...this.entries];
	}

	customData(customType: string): unknown[] {
		return this.entries.flatMap((entry) =>
			entry.type === "custom" && entry.customType === customType ? [entry.data] : [],
		);
	}
}

function createHarness(
	clock: MutableClock,
	session = new MockSession(),
	options: {
		projectTrusted?: boolean;
		configLoader?: RuntimeOptions["configLoader"];
		showInjectedTime?: boolean;
	} = {},
) {
	const warnings: string[] = [];
	const notifications: Array<{ message: string; level: string }> = [];
	const pi = {
		appendEntry: (customType: string, data: unknown) => session.appendCustom(customType, data),
	} as unknown as ExtensionAPI;
	const runtime = new TimeContextRuntime(pi, {
		clock,
		warn: (message) => warnings.push(message),
		configLoader:
			options.configLoader ??
			(() => ({
				config: {
					checkpointIntervalMinutes: 30,
					previousActivityThresholdMinutes: 30,
					timeZone: "UTC",
					showInjectedTime: options.showInjectedTime ?? false,
				},
				warnings: [],
			}))
	});
	const context = {
		cwd: "/project",
		isProjectTrusted: () => options.projectTrusted ?? true,
		sessionManager: session,
		ui: {
			notify: (message: string, level: string) => notifications.push({ message, level }),
		},
	} as unknown as ExtensionContext;
	return { runtime, session, context, warnings, notifications };
}

function startEvent(reason: SessionStartEvent["reason"] = "startup"): SessionStartEvent {
	return { type: "session_start", reason };
}

function endEvent(message: AgentMessage): MessageEndEvent {
	return { type: "message_end", message };
}

function firstContentText(message: AgentMessage | undefined): string | undefined {
	if (!message || (message.role !== "user" && message.role !== "toolResult")) return undefined;
	if (typeof message.content === "string") return undefined;
	const block = message.content[0];
	return block?.type === "text" ? block.text : undefined;
}

function carrierContent(message: AgentMessage | undefined): unknown {
	if (!message || (message.role !== "user" && message.role !== "toolResult")) return undefined;
	return message.content;
}

describe("runtime lifecycle", () => {
	it("shows each newly injected time once when user visibility is enabled", async () => {
		const t0 = Date.UTC(2026, 7, 22, 6, 15);
		const clock = new MutableClock(t0);
		const { runtime, session, context, notifications } = createHarness(clock, undefined, {
			showInjectedTime: true,
		});
		await runtime.onSessionStart(startEvent(), context);

		const first = user(1, "first");
		runtime.onMessageEnd(endEvent(first), context);
		session.appendMessage("u1", first);
		runtime.onContext({ type: "context", messages: [first] }, context);
		runtime.onContext({ type: "context", messages: [first] }, context);

		expect(notifications).toEqual([
			{
				message: "Time context injected:\nsent_at: 2026-08-22 06:15 +00:00",
				level: "info",
			},
		]);
	});

	it("passes project trust to the configuration loader", async () => {
		const clock = new MutableClock(100);
		const includeProjectConfigValues: boolean[] = [];
		const { runtime, context } = createHarness(clock, new MockSession(), {
			projectTrusted: false,
			configLoader: (_cwd, includeProjectConfig) => {
				includeProjectConfigValues.push(includeProjectConfig);
				return {
					config: {
						checkpointIntervalMinutes: 30,
						previousActivityThresholdMinutes: 30,
						timeZone: "UTC",
					},
					warnings: [],
				};
			},
		});
		await runtime.onSessionStart(startEvent(), context);
		runtime.onMessageEnd(endEvent(user(1)), context);

		expect(includeProjectConfigValues).toEqual([false]);
	});

	it("anchors T0 at first user processing and keeps stamped/null decisions immutable across retries", async () => {
		const t0 = Date.UTC(2026, 7, 22, 6, 15);
		const clock = new MutableClock(t0);
		const { runtime, session, context } = createHarness(clock);
		await runtime.onSessionStart(startEvent(), context);

		const first = user(1, "first");
		runtime.onMessageEnd(endEvent(first), context);
		session.appendMessage("u1", first);
		clock.value = t0 + 100;
		const baseline = runtime.onContext({ type: "context", messages: [first] }, context);
		expect(firstContentText(baseline.messages[0])).toBe("sent_at: 2026-08-22 06:15 +00:00");
		expect(carrierContent(first)).toBe("first");

		const second = user(2, "second");
		clock.value = t0 + 5 * 60_000;
		runtime.onMessageEnd(endEvent(second), context);
		session.appendMessage("u2", second);
		const withinBucket = runtime.onContext({ type: "context", messages: [first, second] }, context);
		expect(carrierContent(withinBucket.messages[1])).toBe("second");

		clock.value = t0 + 31 * 60_000;
		const retry = runtime.onContext({ type: "context", messages: [first, second] }, context);
		expect(carrierContent(retry.messages[1])).toBe("second");

		const third = user(3, "third");
		runtime.onMessageEnd(endEvent(third), context);
		session.appendMessage("u3", third);
		const nextCarrier = runtime.onContext({ type: "context", messages: [first, second, third] }, context);
		expect(firstContentText(nextCarrier.messages[2])).toBe("sent_at: 2026-08-22 06:46 +00:00");

		const decisions = session.customData(CARRIER_DECISION_ENTRY) as CarrierDecisionV1[];
		expect(decisions).toHaveLength(3);
		expect(decisions.find((item) => item.carrierEntryId === "u2")?.stamp).toBeNull();
		expect(decisions.find((item) => item.carrierEntryId === "u3")?.stamp).not.toBeNull();
	});

	it("stamps the actual first user when multiple new users share the first request", async () => {
		const t0 = Date.UTC(2026, 7, 22, 6, 0);
		const clock = new MutableClock(t0);
		const { runtime, session, context } = createHarness(clock);
		await runtime.onSessionStart(startEvent(), context);
		const first = user(1, "first");
		const second = user(2, "second");
		runtime.onMessageEnd(endEvent(first), context);
		session.appendMessage("u1", first);
		clock.value = t0 + 1;
		runtime.onMessageEnd(endEvent(second), context);
		session.appendMessage("u2", second);
		const transformed = runtime.onContext({ type: "context", messages: [first, second] }, context);
		expect(firstContentText(transformed.messages[0])).toBe("sent_at: 2026-08-22 06:00 +00:00");
		expect(carrierContent(transformed.messages[1])).toBe("second");
		const decisions = session.customData(CARRIER_DECISION_ENTRY) as CarrierDecisionV1[];
		expect(decisions.find((item) => item.carrierEntryId === "u1")?.stamp).not.toBeNull();
		expect(decisions.find((item) => item.carrierEntryId === "u2")?.stamp).toBeNull();
	});

	it("replays the frozen baseline after reload", async () => {
		const t0 = Date.UTC(2026, 7, 22, 6, 0);
		const clock = new MutableClock(t0);
		const firstHarness = createHarness(clock);
		await firstHarness.runtime.onSessionStart(startEvent(), firstHarness.context);
		const prompt = user(1);
		firstHarness.runtime.onMessageEnd(endEvent(prompt), firstHarness.context);
		firstHarness.session.appendMessage("u", prompt);
		const original = firstHarness.runtime.onContext(
			{ type: "context", messages: [prompt] },
			firstHarness.context,
		);

		clock.value = t0 + 24 * 60 * 60_000;
		const resumed = createHarness(clock, firstHarness.session);
		await resumed.runtime.onSessionStart(startEvent("reload"), resumed.context);
		const replay = resumed.runtime.onContext({ type: "context", messages: [prompt] }, resumed.context);
		expect(JSON.stringify(replay.messages)).toBe(JSON.stringify(original.messages));
		expect(firstHarness.session.customData(CARRIER_DECISION_ENTRY)).toHaveLength(1);
	});

	it("does not backfill a legacy transcript and migrates on the first new carrier", async () => {
		const clock = new MutableClock(Date.UTC(2026, 7, 22, 6, 0));
		const session = new MockSession();
		const old = user(1, "old");
		session.appendMessage("old-user", old);
		const { runtime, context } = createHarness(clock, session);
		await runtime.onSessionStart(startEvent("reload"), context);

		const unchanged = runtime.onContext({ type: "context", messages: [old] }, context);
		expect(carrierContent(unchanged.messages[0])).toBe("old");
		expect(session.customData(SESSION_ANCHOR_ENTRY)).toHaveLength(0);

		const current = user(2, "current");
		clock.value = Date.UTC(2026, 7, 22, 6, 30);
		runtime.onMessageEnd(endEvent(current), context);
		session.appendMessage("new-user", current);
		clock.value = Date.UTC(2026, 7, 22, 6, 31);
		const migrated = runtime.onContext({ type: "context", messages: [old, current] }, context);
		const anchors = session.customData(SESSION_ANCHOR_ENTRY) as SessionAnchorV1[];
		expect(anchors).toHaveLength(1);
		expect(anchors[0]?.origin).toBe("legacy_activation");
		expect(firstContentText(migrated.messages[1])).toBe("sent_at: 2026-08-22 06:31 +00:00");
		expect(session.customData(CARRIER_DECISION_ENTRY)).toHaveLength(1);
	});

	it("batches user and assistant facts at turn end without message bodies", async () => {
		const clock = new MutableClock(100);
		const { runtime, session, context } = createHarness(clock);
		await runtime.onSessionStart(startEvent(), context);
		const prompt = user(1, "secret prompt");
		runtime.onMessageEnd(endEvent(prompt), context);
		session.appendMessage("u", prompt);
		clock.value = 110;
		runtime.onContext({ type: "context", messages: [prompt] }, context);

		const response = assistant(2, "secret response");
		clock.value = 120;
		runtime.onMessageStart(response);
		clock.value = 150;
		runtime.onMessageEnd(endEvent(response), context);
		session.appendMessage("a", response);
		runtime.onTurnEnd(context);

		const batches = session.customData(ACTIVITY_FACTS_ENTRY) as ActivityFactsV1[];
		expect(batches).toHaveLength(1);
		expect(batches[0]?.activities).toHaveLength(2);
		expect(JSON.stringify(batches)).not.toContain("secret");
		expect(batches[0]?.activities.find((item) => item.kind === "assistant")).toMatchObject({
			requestedAtMs: 110,
			streamStartedAtMs: 120,
			completedAtMs: 150,
		});
	});

	it("uses actual parallel tool completion order for the stamped tool-result carrier", async () => {
		const t0 = Date.UTC(2026, 7, 22, 6, 0);
		const clock = new MutableClock(t0);
		const { runtime, session, context } = createHarness(clock);
		await runtime.onSessionStart(startEvent(), context);
		const prompt = user(1);
		runtime.onMessageEnd(endEvent(prompt), context);
		session.appendMessage("u", prompt);
		runtime.onContext({ type: "context", messages: [prompt] }, context);

		const response = assistantWithTools(2, ["a", "b"]);
		clock.value = t0 + 1_000;
		runtime.onMessageStart(response);
		clock.value = t0 + 2_000;
		runtime.onMessageEnd(endEvent(response), context);
		session.appendMessage("assistant", response);

		clock.value = t0 + 3_000;
		runtime.onToolStart({ type: "tool_execution_start", toolCallId: "a", toolName: "test", args: {} });
		clock.value = t0 + 4_000;
		runtime.onToolStart({ type: "tool_execution_start", toolCallId: "b", toolName: "test", args: {} });
		clock.value = t0 + 35 * 60_000;
		runtime.onToolEnd({
			type: "tool_execution_end",
			toolCallId: "b",
			toolName: "test",
			result: {},
			isError: false,
		});
		clock.value = t0 + 40 * 60_000;
		runtime.onToolEnd({
			type: "tool_execution_end",
			toolCallId: "a",
			toolName: "test",
			result: {},
			isError: false,
		});
		const resultA = toolResult(3, "a");
		const resultB = toolResult(4, "b");
		session.appendMessage("result-a", resultA);
		session.appendMessage("result-b", resultB);
		runtime.onTurnEnd(context);

		const transformed = runtime.onContext(
			{ type: "context", messages: [prompt, response, resultA, resultB] },
			context,
		);
		expect(firstContentText(transformed.messages[2])).toBe("sent_at: 2026-08-22 06:40 +00:00");
		expect(firstContentText(transformed.messages[3])).toBe("result");
		const decisions = session.customData(CARRIER_DECISION_ENTRY) as CarrierDecisionV1[];
		expect(decisions.find((item) => item.carrierEntryId === "result-a")?.stamp).not.toBeNull();
		expect(decisions.find((item) => item.carrierEntryId === "result-b")?.stamp).toBeNull();
	});
});
