# Changelog

## Unreleased

### Changed

- Stamps are now a self-describing `⟦TIME event=... at=...⟧` annotation instead of a bare `sent_at:` line, so the model can no longer mistake them for part of the message or tool output. A fixed one-line explanation of the format is appended to the system prompt.
- Tool result stamps no longer carry an idle duration; a gap on a tool result is usually the tool's own execution time, and labeling it as user idle was misleading. User message stamps keep `idle=` when the previous activity ended more than the configured threshold ago.
- The dim timestamp line in the chat UI shows the exact `⟦TIME event=... at=...⟧` annotation the model receives — including `idle=` and the policy time zone — so what you see and what the model sees are byte-identical. It appears above the message it belongs to and is rendered the moment you submit input, frozen at submission using the same checkpoint policy as the model-facing stamp.
- Timestamp values and idle durations are frozen exactly as before; after upgrading, existing sessions simply re-render their stamps in the new format.

### Fixed

- With the time zone set to `local`, stamps now follow a system time zone change made while a session is running. Node resolves its zone once at startup, so a long-lived session used to keep stamping the old offset. The change is recorded as a policy revision effective from the next stamp; stamps already sent keep their zone. A pinned zone (`/time-config tz <IANA|UTC>`) or a `TZ` environment variable is never overridden.

### Added

- After a compaction, the summary now carries a `⟦TIME event=context_summary_created covers_from=... covers_until=...⟧` annotation telling the model when the session began and when the summarized activity ended — not just the session start.

## [0.1.0] - 2026-09-11

First release of `pi-time-context`, a Pi agent extension that gives conversations wall-clock context.

### Features

- **Wall-clock time context** — each stamped message carries an absolute local time with UTC offset:

  ```text
  sent_at: 2026-08-22 14:15 +08:00
  user_idle_for: 2h15m
  ```

- **Sparse by default** — a baseline stamp marks the session start; after that, at most one stamp per 10-minute window (configurable), attached to the next outbound user message or tool result. No timers, no background work, and no timestamp noise in model context.
- **Idle-aware** — when the previous activity ended more than 30 minutes ago (configurable), the stamp also includes `user_idle_for`, telling the model the conversation has a gap.
- **Every-message mode** — optionally stamp every message instead of using intervals.
- **Deterministic** — stamps are frozen the first time a message is sent; retries, `/resume`, `/reload`, `/fork`, `/clone`, and `/tree` reproduce identical timestamps, keeping prompt caches warm.
- **Visible, not intrusive** — the model sees the stamps; you see a dim one-line marker in the chat UI. Session files, stored messages, and the system prompt are never modified, and no message content is ever persisted.
- **Compaction-safe** — after compaction, a `session_started_at:` line preserves the session start time.

### Configuration

- `/time-config` opens an interactive menu to set the stamping interval (including every-message mode), the idle threshold, and the render time zone (`local`, `UTC`, or any IANA name).
- Text subcommands: `/time-config show`, `interval <minutes|every>`, `threshold <minutes>`, `tz <IANA|local|UTC>`.
- Settings persist in `~/.pi/agent/pi-time-context.json` and apply to subsequent messages immediately.

[0.1.0]: https://github.com/Sevten/pi-time-context/releases/tag/v0.1.0
