# pi-time-context

A [Pi](https://github.com/earendil-works/pi) agent extension that gives conversations wall-clock context — sparse, stable, and quiet.

`pi-time-context` attaches a small timestamp block to outbound user messages and tool results at intervals — just enough for the model to always know the real time, without stamping every message:

```text
⟦TIME event=user_message_sent at=2026-08-22T14:15+08:00 idle=2h15m⟧

Your original message or tool result...
```

## How it works

When the first message of a session is sent, it receives a baseline stamp marking the session start. After that, a stamp is added only once a 10-minute window (configurable) has passed, attached to the next outbound user message or tool result.

- **Sparse by design** — a few well-placed stamps give the model a sense of real time without filling its context with timestamp noise; if you truly want a stamp on every message, one option turns it on.
- **Idle-aware** — when the previous assistant or tool activity ended more than 30 minutes ago (configurable), a user message stamp also includes `idle=2h15m`, telling the model the conversation has a gap.
- **Deterministic** — each stamp's time and idle duration are frozen the first time a message is sent. Retries, `/resume`, `/reload`, `/fork`, `/clone`, and `/tree` reproduce identical timestamps, and already-sent context never changes, keeping prompt caches warm.
- **Visible, not intrusive** — the model sees the stamps; you see them too, as a dim one-line marker in the chat UI. Session data is never touched; the only system-prompt change is one fixed line explaining the annotation format.

## Installation

```bash
pi install npm:@sevten/pi-time-context
```

## Usage

Nothing to set up. In the chat UI, each stamped message carries the exact annotation above it, rendered the moment you submit — for example:

```text
⟦TIME event=user_message_sent at=2026-08-22T14:15+08:00 idle=2h15m⟧
```

That marker is byte-identical to what the model received — nothing extra is written into the session file. After a compaction drops the session's early messages, the summary carries a `⟦TIME event=context_summary_created covers_from=... covers_until=...⟧` annotation so the model still knows when the session began and when the covered activity ended.

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
- **Show idle gap after** — minimum idle gap before `idle=` is added to user message stamps.
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
