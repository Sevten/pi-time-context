import type { ContextEvent, ExtensionEvent } from "@earendil-works/pi-coding-agent";

export type AgentMessage = ContextEvent["messages"][number];
export type MessageEndEvent = Extract<ExtensionEvent, { type: "message_end" }>;
export type MessageUpdateEvent = Extract<ExtensionEvent, { type: "message_update" }>;
export type AssistantMessageEvent = MessageUpdateEvent["assistantMessageEvent"];
export type ToolExecutionStartEvent = Extract<ExtensionEvent, { type: "tool_execution_start" }>;
export type ToolExecutionEndEvent = Extract<ExtensionEvent, { type: "tool_execution_end" }>;
