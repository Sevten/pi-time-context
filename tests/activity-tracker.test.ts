import { describe, expect, it } from "vitest";
import { ActivityTracker } from "../src/activity-tracker.js";
import type { AssistantMessageEvent } from "../src/pi-types.js";
import type { ActivityV1 } from "../src/types.js";
import { assistant, messageEntry, MutableClock, toolResult, user } from "./helpers.js";

describe("activity tracker", () => {
	it("records provider request, stream, first content, and completion boundaries", () => {
		const clock = new MutableClock(0);
		const tracker = new ActivityTracker(clock);
		const starting = assistant(10, "");
		const updated = assistant(10, "hello");
		if (updated.role !== "assistant") throw new Error("Expected assistant message");
		const updateEvent = {
			type: "text_delta",
			contentIndex: 0,
			delta: "hello",
			partial: updated,
		} satisfies AssistantMessageEvent;

		tracker.noteContextRequest(100);
		clock.value = 200;
		tracker.onMessageStart(starting);
		clock.value = 300;
		tracker.onMessageUpdate(updated, updateEvent);
		clock.value = 400;
		tracker.onMessageEnd(updated);

		const branch = [messageEntry("assistant-entry", null, updated)];
		const activities = tracker.resolveActivities(branch, new Map());
		expect(activities).toEqual([
			{
				key: "assistant:assistant-entry",
				kind: "assistant",
				messageEntryId: "assistant-entry",
				requestedAtMs: 100,
				streamStartedAtMs: 200,
				firstContentAtMs: 300,
				completedAtMs: 400,
			},
		]);
	});

	it("pairs tool timings by toolCallId and keeps actual completion order", () => {
		const clock = new MutableClock(100);
		const tracker = new ActivityTracker(clock);
		tracker.onToolStart("a");
		clock.value = 110;
		tracker.onToolStart("b");
		clock.value = 150;
		tracker.onToolEnd("b", true);
		clock.value = 200;
		tracker.onToolEnd("a", false);

		const resultA = toolResult(201, "a");
		const resultB = toolResult(202, "b");
		const branch = [
			messageEntry("result-a", null, resultA),
			messageEntry("result-b", "result-a", resultB),
		];
		const activities = tracker.resolveActivities(branch, new Map());
		expect(activities).toEqual([
			{
				key: "tool:a",
				kind: "tool",
				toolCallId: "a",
				toolResultEntryId: "result-a",
				startedAtMs: 100,
				completedAtMs: 200,
				isError: false,
			},
			{
				key: "tool:b",
				kind: "tool",
				toolCallId: "b",
				toolResultEntryId: "result-b",
				startedAtMs: 110,
				completedAtMs: 150,
				isError: true,
			},
		]);
	});

	it("uses user processing time rather than the native message timestamp", () => {
		const clock = new MutableClock(900);
		const tracker = new ActivityTracker(clock);
		const prompt = user(1);
		tracker.onMessageEnd(prompt);
		const existing = new Map<string, ActivityV1>();
		expect(tracker.resolveActivities([messageEntry("u", null, prompt)], existing)).toEqual([
			{ key: "user:u", kind: "user", messageEntryId: "u", processedAtMs: 900 },
		]);
	});
});
