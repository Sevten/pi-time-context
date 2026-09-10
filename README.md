# pi-time-context

Deterministic, cache-stable wall-clock context for Pi conversations.

`pi-time-context` is a Pi extension that gives language models an explicit sense of real-world time. It prepends a small timestamp block to selected outbound user and tool-result messages without changing the system prompt or the messages stored in the Pi session.

A model may receive context like this:

```text
sent_at: 2026-08-22 14:15 +08:00
elapsed_since_last_activity: 2小时15分钟

Your original message or tool result...
```

The extension is designed for long-running, resumed, forked, and provider-retried conversations where timestamps must remain deterministic instead of changing whenever context is rebuilt.

## Highlights

- **Real wall-clock context** — exposes an absolute local time with a numeric UTC offset.
- **Deterministic replay** — freezes each timestamp decision before the message is first sent and reuses it on retries and reloads.
- **Cache-friendly behavior** — timestamps are added at fixed checkpoints rather than to every message.
- **Lifecycle-aware elapsed time** — can tell the model how long it has been since the previous assistant or tool activity completed.
- **Session-safe injection** — modifies only the outbound context copy; persisted user, assistant, and tool-result messages remain untouched.
- **Branch-aware recovery** — restores decisions across resume, reload, fork, clone, and tree navigation.
- **Privacy-conscious persistence** — does not copy message bodies, tool arguments, or tool output into extension metadata.
- **No background work** — starts no timers, polling loops, or model-callable tools.

## Requirements

- Node.js `>=22.19.0`
- Built and tested against `@earendil-works/pi-coding-agent@0.80.3`

## Installation

Install the package from npm:

```bash
pi install npm:@sevten/pi-time-context
```

Install it only for the current project:

```bash
pi install -l npm:@sevten/pi-time-context
```

To install a local checkout instead:

```bash
pi install /path/to/pi-time-context
```

Or enable a local checkout for a single run without installing it:

```bash
pi -e /path/to/pi-time-context
```

Pi discovers the extension through the `pi.extensions` entry in `package.json`. No command or prompt setup is required after installation.

## How it works

### Session anchor

When Pi processes the first user message in a new session, the extension freezes a session anchor (`T0`). The outbound copy of that first message receives a baseline timestamp:

```text
sent_at: 2026-08-22 14:15 +08:00
```

The internal name `T0` is never shown to the model.

### Checkpoints

By default, the next checkpoints are `T0 + 30m`, `T0 + 60m`, `T0 + 90m`, and so on. The extension does not wake up when a checkpoint passes. It checks the clock only when a new user message or tool result is about to be sent to the model.

If one or more checkpoint intervals have passed, the next eligible message receives one timestamp block. Skipping several intervals does not produce several timestamps.

### Elapsed activity

When a checkpoint is due, the extension compares the message's send time with the completion time of the previous assistant or tool activity. If the gap is strictly greater than the configured threshold, it adds a second line:

```text
sent_at: 2026-08-22 14:15 +08:00
elapsed_since_last_activity: 2小时15分钟
```

Elapsed durations are rounded to minutes. The current renderer uses the compact Chinese units `小时` (hours) and `分钟` (minutes).

### Injection location

The timestamp is inserted as an independent text content block before the original content:

```text
[timestamp text block]
[original text/image content blocks]
```

This preserves the original content blocks and their order. The extension never adds a separate message between an assistant tool call and its tool result.

### Compaction

When compaction removes the session's first stamped message from the context, the model would otherwise lose the session start time. The extension detects a compaction summary at the head of the context and prepends a `session_started_at` line (rendered from the persisted session anchor) to the summary text on the outbound copy only. Messages after the summary continue to receive their normal `sent_at` stamps.

## Configuration

The extension works without a configuration file. Its defaults are:

| Option | Default | Description |
| --- | ---: | --- |
| `checkpointIntervalMinutes` | `30` | Minutes between timestamp checkpoints. |
| `previousActivityThresholdMinutes` | `30` | Minimum activity gap before adding `elapsed_since_last_activity`. The comparison is strictly greater than this value. |
| `timeZone` | `"local"` | Time zone used to render `sent_at`. |
| `stampEveryMessage` | `false` | Stamp every outbound user and tool-result message instead of using checkpoint intervals. |

Create a global configuration file at:

```text
~/.pi/agent/pi-time-context.json
```

Or add a project-level override at:

```text
<project>/.pi/pi-time-context.json
```

Example:

```json
{
  "checkpointIntervalMinutes": 30,
  "previousActivityThresholdMinutes": 30,
  "timeZone": "local",
  "stampEveryMessage": false
}
```

### The `/time-config` command

Inside Pi you can inspect and change the configuration without leaving the session:

```text
/time-config                          show the interactive menu
/time-config show                     current effective config and recent stamps
/time-config interval <minutes> [-g]  change the checkpoint interval
/time-config every [-g]               toggle stamping every message
/time-config threshold <minutes> [-g] change the previous-activity threshold
/time-config tz <IANA|local|UTC> [-g] change the render time zone
```

- Without `-g` / `--global` the change is written to the project config file; with it, to the global file.
- Every successful change also records an in-session policy revision, so it takes effect immediately for messages that have not been sent yet. Previously stamped messages are never re-rendered.
- Switching intervals re-buckets checkpoints from the session anchor (T0); the next stamp may therefore arrive sooner or later than the old phase implied.
- While the extension is active, the footer status line at the bottom of the window shows the current time and the next checkpoint.
- Stamped messages show a dim inline marker in the chat transcript (for example `sent_at 14:15 +08:00`), rendered from the persisted decision entries without touching session data.
- Configuration files are only read when a session anchor is created; editing them mid-session does not affect the running session (use `/time-config` instead).

### Configuration rules


- Project values override global values field by field.
- Interval values must be finite numbers from `1` through `10080`.
- `timeZone` accepts `"local"`, `"UTC"`, or an IANA time zone supported by the runtime, such as `"Asia/Shanghai"` or `"America/New_York"`.
- `"local"` is resolved to a concrete IANA time zone when the session anchor is created.
- The resolved policy is frozen with the session anchor. Configuration changes affect only sessions that have not created an anchor yet.
- Invalid or unknown fields produce warnings and fall back to the previous valid configuration layer or the defaults.
- Project configuration is ignored while Pi considers the project untrusted.
- The project configuration directory follows Pi's `CONFIG_DIR_NAME`; `.pi` is the default.

## Deterministic sessions and retries

Before an eligible message is first sent to the model, the extension persists either a stamped decision or an explicit no-stamp decision. Rebuilding context therefore cannot add a new timestamp to a message that was originally sent without one, and an existing timestamp cannot drift with the current clock or configuration.

This behavior applies to provider retries and to session recovery through `/resume`, `/reload`, `/fork`, `/clone`, and `/tree`.

For an existing session created before the extension was enabled:

- historical messages are not modified or backfilled;
- the first new eligible message establishes a migration anchor;
- that message receives a normal `sent_at` value, not a false conversation-start marker.

## Persistence and privacy

The extension stores its state in three Pi custom-entry types that are excluded from model context:

```text
pi-time-context/session-anchor
pi-time-context/activity-facts
pi-time-context/carrier-decision
```

These records contain only the data required for deterministic recovery, including epoch timestamps, session-message entry IDs, tool-call IDs, error flags, the frozen policy, and rendering decisions.

They do **not** duplicate:

- user or assistant message bodies;
- tool arguments;
- tool output.

Additional invariants:

- the system prompt is never modified;
- historical assistant messages are never annotated;
- original session messages are never rewritten;
- only outbound context copies receive timestamp blocks;
- a system-clock rollback still permits an absolute timestamp, but suppresses a negative elapsed duration.

## Limitations

- This extension provides context, not a model-callable clock tool.
- It does not wake the agent, schedule work, or poll in the background.
- It does not provide TUI timestamps, dashboards, or analytics.
- It does not perform a separate calendar-day transition check because `sent_at` already includes the full date.
- Cross-process replay requires a persistent Pi session file.
- Elapsed-duration labels currently use Chinese hour/minute units.

## Development

```bash
npm ci --ignore-scripts
npm run validate
```

`npm run validate` runs the TypeScript check, the Vitest suite, and an npm package dry run.

## License

[MIT](LICENSE)
