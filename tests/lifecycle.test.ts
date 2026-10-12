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
	UI_STAMP_ENTRY,
	type ActivityFactsV1,
	type CarrierDecisionV1,
	type SessionAnchorV1,
	type UiStampV1,
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
		configLoader?: RuntimeOptions["configLoader"];
		systemTimeZone?: RuntimeOptions["systemTimeZone"];
	} = {},
) {
	const warnings: string[] = [];
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
					stampEveryMessage: false,
				},
				warnings: [],
			})),
		systemTimeZone: options.systemTimeZone,
	});
	const context = {
		cwd: "/project",
		isProjectTrusted: () => true,
		sessionManager: session,
	} as unknown as ExtensionContext;
	return { runtime, session, context, warnings };
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
		expect(firstContentText(baseline.messages[0])).toBe("\u27e6TIME event=user_message_sent at=2026-08-22T06:15+00:00\u27e7");
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
		expect(firstContentText(nextCarrier.messages[2])).toBe("\u27e6TIME event=user_message_sent at=2026-08-22T06:46+00:00\u27e7");

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
		expect(firstContentText(transformed.messages[0])).toBe("\u27e6TIME event=user_message_sent at=2026-08-22T06:00+00:00\u27e7");
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
		expect(firstContentText(migrated.messages[1])).toBe("\u27e6TIME event=user_message_sent at=2026-08-22T06:31+00:00\u27e7");
		expect(session.customData(CARRIER_DECISION_ENTRY)).toHaveLength(1);
	});

	it("appends the system prompt note once and is idempotent", async () => {
		const clock = new MutableClock(0);
		const { runtime } = createHarness(clock);
		const base = "You are pi.";
		const first = runtime.onBeforeAgentStart({ type: "before_agent_start", prompt: "hi", systemPrompt: base } as never);
		expect(first?.systemPrompt).toContain("\u27e6TIME event=...");
		expect(first?.systemPrompt.startsWith("You are pi.")).toBe(true);

		const second = runtime.onBeforeAgentStart({
			type: "before_agent_start",
			prompt: "hi",
			systemPrompt: first?.systemPrompt ?? "",
		} as never);
		expect(second).toBeUndefined();
	});

	it("stamps a compaction summary with the covered span deterministically", async () => {
		const t0 = Date.UTC(2026, 7, 22, 6, 0);
		const clock = new MutableClock(t0);
		const { runtime, session, context } = createHarness(clock);
		await runtime.onSessionStart(startEvent(), context);
		const prompt = user(1, "first");
		runtime.onMessageEnd(endEvent(prompt), context);
		session.appendMessage("u1", prompt);
		runtime.onContext({ type: "context", messages: [prompt] }, context);
		const response = assistant(2, "done");
		session.appendMessage("a1", response);
		runtime.onTurnEnd(context);

		// A compaction lands after a1; everything before it is covered.
		session.entries.push({
			type: "compaction",
			id: "c1",
			parentId: "a1",
			timestamp: new Date(t0 + 60 * 60_000).toISOString(),
			summary: "summary of earlier talk",
			firstKeptEntryId: "a1",
			tokensBefore: 500,
		} as SessionEntry);
		const summaryMessage = {
			role: "compactionSummary",
			summary: "summary of earlier talk",
			tokensBefore: 500,
			timestamp: t0 + 60 * 60_000,
		} as AgentMessage;

		const first = runtime.onContext({ type: "context", messages: [summaryMessage] }, context);
		const second = runtime.onContext({ type: "context", messages: [summaryMessage] }, context);
		for (const run of [first, second]) {
			const message = run.messages[0];
			if (message?.role !== "compactionSummary") throw new Error("Expected compaction summary");
			expect(message.summary).toBe(
				"\u27e6TIME event=context_summary_created covers_from=2026-08-22T06:00+00:00 covers_until=2026-08-22T06:00+00:00\u27e7\n\nsummary of earlier talk",
			);
		}
	});

	describe("ui stamps", () => {
		const inputEvent = (text: string) => ({ type: "input", text, source: "interactive" }) as never;

		function stampEntries(session: { entries: { type: string; customType?: string; id: string }[] }) {
			return session.entries.filter(
				(entry): entry is { type: "custom"; customType: string; id: string } =>
					entry.type === "custom" && entry.customType === UI_STAMP_ENTRY,
			);
		}

		it("writes a self-contained baseline stamp on the first input, before the message exists", async () => {
			const t0 = Date.UTC(2026, 7, 22, 6, 0);
			const clock = new MutableClock(t0);
			const { runtime, session, context } = createHarness(clock);
			await runtime.onSessionStart(startEvent(), context);

			clock.value = t0 + 1;
			runtime.onInput(inputEvent("hello"), context);
			expect(stampEntries(session)).toHaveLength(1);
			const stampData = session.customData(UI_STAMP_ENTRY) as UiStampV1[];
			expect(stampData[0]).toEqual({ version: 1, sentAtMs: t0 + 1 });

			const prompt = user(1, "hello");
			runtime.onMessageEnd(endEvent(prompt), context);
			session.appendMessage("u1", prompt);
			clock.value = t0 + 2;
			runtime.onContext({ type: "context", messages: [prompt] }, context);
			expect(runtime.carrierHasUiStamp("u1")).toBe(true);
		});

		it("writes nothing when the checkpoint is not due", async () => {
			const t0 = Date.UTC(2026, 7, 22, 6, 0);
			const clock = new MutableClock(t0);
			const { runtime, session, context } = createHarness(clock);
			await runtime.onSessionStart(startEvent(), context);

			clock.value = t0 + 1;
			runtime.onInput(inputEvent("first"), context);
			const prompt = user(1, "first");
			runtime.onMessageEnd(endEvent(prompt), context);
			session.appendMessage("u1", prompt);
			runtime.onContext({ type: "context", messages: [prompt] }, context);
			expect(stampEntries(session)).toHaveLength(1);

			clock.value = t0 + 5 * 60_000;
			runtime.onInput(inputEvent("second"), context);
			expect(stampEntries(session)).toHaveLength(1);
		});

		it("stops mapping a stamp once an assistant message intervenes", async () => {
			const t0 = Date.UTC(2026, 7, 22, 6, 0);
			const clock = new MutableClock(t0);
			const { runtime, session, context } = createHarness(clock);
			await runtime.onSessionStart(startEvent(), context);

			clock.value = t0 + 1;
			runtime.onInput(inputEvent("doomed"), context);
			const reply = assistant(2, "reply");
			session.appendMessage("a1", reply);
			runtime.onMessageEnd(endEvent(reply), context);
			runtime.onTreeChanged(context);

			expect(stampEntries(session)).toHaveLength(1);
			expect(runtime.carrierHasUiStamp("a1")).toBe(false);
		});
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
		expect(firstContentText(transformed.messages[2])).toBe("\u27e6TIME event=tool_result_returned at=2026-08-22T06:40+00:00\u27e7");
		expect(firstContentText(transformed.messages[3])).toBe("result");
		const decisions = session.customData(CARRIER_DECISION_ENTRY) as CarrierDecisionV1[];
		expect(decisions.find((item) => item.carrierEntryId === "result-a")?.stamp).not.toBeNull();
		expect(decisions.find((item) => item.carrierEntryId === "result-b")?.stamp).toBeNull();
	});

	it("follows a mid-session system time zone change unless a zone is pinned", async () => {
		const previousTz = process.env.TZ;
		process.env.TZ = "America/New_York";
		try {
			for (const pinned of [false, true]) {
				const t0 = Date.UTC(2026, 0, 22, 18, 0);
				const clock = new MutableClock(t0);
				let zone = "America/New_York";
				const { runtime, session, context } = createHarness(clock, new MockSession(), {
					systemTimeZone: () => zone,
					configLoader: () => ({
						config: {
							checkpointIntervalMinutes: 30,
							previousActivityThresholdMinutes: 30,
							timeZone: pinned ? "America/New_York" : "local",
							stampEveryMessage: false,
						},
						warnings: [],
					}),
				});
				await runtime.onSessionStart(startEvent(), context);

				const first = user(1, "first");
				runtime.onMessageEnd(endEvent(first), context);
				session.appendMessage("u1", first);
				runtime.onContext({ type: "context", messages: [first] }, context);

				zone = "America/Los_Angeles";
				const second = user(2, "second");
				clock.value = t0 + 40 * 60_000;
				runtime.onMessageEnd(endEvent(second), context);
				session.appendMessage("u2", second);
				const result = runtime.onContext({ type: "context", messages: [first, second] }, context);

				expect(firstContentText(result.messages[0])).toBe(
					"\u27e6TIME event=user_message_sent at=2026-01-22T13:00-05:00\u27e7",
				);
				expect(firstContentText(result.messages[1])).toContain(
					pinned ? "at=2026-01-22T13:40-05:00" : "at=2026-01-22T10:40-08:00",
				);
			}
		} finally {
			if (previousTz === undefined) delete process.env.TZ;
			else process.env.TZ = previousTz;
		}
	});
});
