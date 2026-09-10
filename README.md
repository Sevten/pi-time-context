# pi-time-context

A [Pi](https://github.com/earendil-works/pi) agent extension that gives conversations wall-clock context — sparse, stable, and quiet.

`pi-time-context` attaches a small timestamp block to outbound user messages and tool results at intervals — just enough for the model to always know the real time, without stamping every message:

```text
sent_at: 2026-08-22 14:15 +08:00
user_idle_for: 2h15m

Your original message or tool result...
```

## How it works

When the first message of a session is sent, it receives a baseline stamp marking the session start. After that, a stamp is added only once a 10-minute window (configurable) has passed, attached to the next outbound user message or tool result.

- **Sparse by design** — a few well-placed stamps give the model a sense of real time without filling its context with timestamp noise; if you truly want a stamp on every message, one option turns it on.
- **Idle-aware** — when the previous assistant or tool activity ended more than 30 minutes ago (configurable), the stamp also includes `user_idle_for`, telling the model the conversation has a gap.
- **Deterministic** — each stamp is frozen the first time a message is sent. Retries, `/resume`, `/reload`, `/fork`, `/clone`, and `/tree` reproduce identical timestamps, and already-sent context never changes, keeping prompt caches warm.
- **Visible, not intrusive** — the model sees the stamps; you see them too, as a dim one-line marker in the chat UI. Session data and the system prompt are never touched.

## Installation

```bash
pi install npm:@sevten/pi-time-context
```

## Usage

Nothing to set up. In the chat UI, each stamped message shows a dim marker under it, for example:

```text
sent_at 14:15 +08:00 · User idle for 2h15m
```

That marker mirrors exactly what the model received — nothing extra is written into the session file. After a compaction drops the session's early messages, a `session_started_at:` line is prepended to the summary so the model still knows when the session began.

### Configuring with `/time-config`

There are two ways to configure, both writing to the global config file (`~/.pi/agent/pi-time-context.json`) and taking effect right away — subsequent messages are stamped by the new settings, while already-stamped messages keep their original stamps.

**Interactive menu** — run `/time-config` without arguments:

```text
  Stamp a timestamp every   10 min
  Show idle gap after       30 min idle
  Show times in             local

  enter select  ·  esc back
```

- **Stamp a timestamp every** — presets (5, 10, 15, 30, 60, 120 min), `Every message`, or a custom value. Picking a concrete interval switches every-message mode off, and vice versa.
- **Show idle gap after** — minimum idle gap before `user_idle_for` is added.
- **Show times in** — `local`, `UTC`, or any IANA time zone (`Asia/Shanghai`); custom values are typed inline.

**Text commands**:

```text
/time-config show                     current config, next checkpoint, recent stamps
/time-config interval <minutes|every>  set the interval, or "every" for every-message mode
/time-config threshold <minutes>
/time-config tz <IANA|local|UTC>
```

## Development

```bash
npm ci --ignore-scripts
npm run validate
```

`npm run validate` runs the TypeScript check, the Vitest suite, and an npm package dry run.

## License

[MIT](LICENSE)
