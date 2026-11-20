# Changelog

## [Unreleased]

### Added

- Tests for `time-config-menu.ts` (menu state machine: main list, presets, every-message mode, Custom inline editing incl. invalid input handling and escape/backspace behavior) and `fork-copy.ts` (anchor/activity/decision copying: dedup, branch filtering, malformed and missing previous-session files).

### Fixed

- Steering inputs (submitted while streaming, `streamingBehavior` set) now get a UI stamp like normal inputs, so the dim stamp line above the message matches the model-side carrier annotation instead of falling back to a stamp line rendered below the message.
- The session anchor's `t0` is now taken from the user's submission time instead of the later processing time, so the UI stamp shown above the message and the anchor the model sees can no longer disagree by a minute when the first message straddles a minute boundary. Falls back to the processing time when no input event preceded the message.
- Clock rollback is now detected symmetrically: a computed checkpoint index that falls below the last stamped index is reported as a clock anomaly (with a warning) instead of silently under-stamping until the wall clock catches up. Tests now cover the rollback path.
- Extreme idle durations of 24 hours or more render as `Xd` / `Xd Yh` instead of unbounded hour counts (`idle=1234h`), keeping the ⟦TIME⟧ idle field parseable for multi-day sessions.

### Changed

- Session state is now folded incrementally: appended entries are merged into the cached state instead of re-parsing the whole session file on every input/context/message-end/turn-end event. Any non-append-only change (tree switch, compaction rewrite) still triggers a full rebuild.
- The config file is read once and cached; `followSystemTimeZone` no longer synchronously re-reads it on every input/context event. The cache is invalidated after an explicit config write through `/time-config`.
- The pi devDependency is tightened from `^1.1.0` to `~1.1.0` (with npm `overrides` pinning the `@earendil-works/*` transitive packages to 1.1.x), so local type checks run against the same minor as the host instead of drifting ahead of it. `pi-tui` moves from 0.85.1 to ~1.1.0 for the same reason.

### Added

- `npm run check-host` (also part of `validate`): compares the globally installed pi version against the declared devDependency range and fails loudly on a mismatch, so "green locally, broken on the host" drift becomes visible. Skips cleanly (exit 0) when no host pi is present, e.g. on CI.

- The `scope` field was removed from the policy revision record (schema v1). Policy revisions have always been global for the whole session — there is no project-level configuration. Records persisted by earlier versions that carry `scope: "global"` are still read; a revision claiming any other scope is rejected as malformed.

## [0.2.0] - 2026-10-14

### Changed

- Stamps are now a self-describing `⟦TIME event=... at=...⟧` annotation instead of a bare `sent_at:` line, so the model can no longer mistake them for part of the message or tool output.
- The dim timestamp line in the chat UI shows the exact `⟦TIME event=... at=...⟧` annotation the model receives, above the message it belongs to.
- Tool result stamps no longer carry an idle duration; a gap on a tool result is usually the tool's own execution time, and labeling it as user idle was misleading.

### Fixed

- With the time zone set to `local`, stamps now follow a system time zone change made while a session is running; stamps already sent keep their zone. A pinned zone (`/time-config tz <IANA|UTC>`) or a `TZ` environment variable is never overridden.

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

[0.2.0]: https://github.com/Sevten/pi-time-context/releases/tag/v0.2.0
[0.1.0]: https://github.com/Sevten/pi-time-context/releases/tag/v0.1.0
