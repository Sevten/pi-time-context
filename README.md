# pi-time-context

`pi-time-context` 是一个 Pi 扩展，用确定、可重放的方式向模型提供现实时间。它不修改 system prompt，也不修改 Pi 持久化的原始 user、assistant 或 toolResult 消息。

## 兼容性

- 目标版本：`@earendil-works/pi-coding-agent@0.80.3`
- Node.js：`>=22.19.0`

实现只使用 Pi 0.80.3 已有的 `context`、消息生命周期、工具生命周期和 session 生命周期事件。

## 安装

从本地目录安装：

```bash
pi install /path/to/pi-time-context
```

仅在当前项目启用：

```bash
pi install -l /path/to/pi-time-context
```

发布到 npm 后可使用：

```bash
pi install npm:@sevten/pi-time-context
```

也可以不安装，直接试运行：

```bash
pi -e /path/to/pi-time-context
```

Pi package 会从 `src/index.ts` 加载扩展。

## 行为

新会话第一条 user 消息真正被 Pi agent loop 处理时，扩展冻结会话锚点 T0，并在该消息首次发送给模型的副本中追加：

```text
sent_at: 2026-08-22 14:15 +08:00
```

默认检查点固定为 `T0 + 30m`、`T0 + 60m`、`T0 + 90m`。扩展不启动定时器；只有新的 user 或 toolResult 即将发送给模型时才检查是否跨入新检查区间。一次跨过多个区间只追加一个时间戳。

当检查点已到，并且当前 carrier 距离上一 assistant 或工具活动完成时间严格超过阈值时，扩展追加第二行：

```text
sent_at: 2026-08-22 14:15 +08:00
elapsed_since_last_activity: 2小时15分钟
```

时间决策在 carrier 第一次发送前持久化。有时间戳和无时间戳的决策都会记录，因此 provider retry 不会给同一 carrier 动态补写时间。`/resume`、`/reload`、`/fork`、`/clone` 和 `/tree` 会按当前分支恢复相同决策。

已有历史但没有扩展锚点的会话不会被回填。扩展在接管后的第一个新 carrier 上建立 `legacy_activation` 迁移锚点，并只追加普通 `sent_at`。

## 配置

全局配置：

```text
~/.pi/agent/pi-time-context.json
```

项目覆盖（默认配置目录名为 `.pi`）：

```text
<project>/.pi/pi-time-context.json
```

扩展遵循 Pi 的项目信任状态：项目未受信任时不会读取项目配置，只使用全局配置和默认值。项目配置目录通过 Pi 的 `CONFIG_DIR_NAME` 解析，兼容使用其他配置目录名的发行版。

示例：

```json
{
  "checkpointIntervalMinutes": 30,
  "previousActivityThresholdMinutes": 30,
  "timeZone": "local",
  "showInjectedTime": false
}
```

- 项目字段覆盖全局同名字段。
- 两个分钟值必须是 `1` 到 `10080` 之间的有限正数。
- `timeZone` 支持 `local`、`UTC` 或运行时 `Intl` 支持的 IANA 时区，例如 `Asia/Shanghai`。
- `local` 在创建锚点时解析为具体 IANA 时区。
- `showInjectedTime` 默认为 `false`；设为 `true` 后，每次实际注入都会在前端显示一次通知，但仍不会修改聊天消息正文。修改后执行 `/reload` 即可对当前会话生效。
- 策略随会话锚点冻结；修改配置只影响尚未创建锚点的会话。
- 非法字段和未知字段会告警；非法值回退到上一层有效值或默认值，不阻止扩展启动。

## 持久化与隐私

扩展写入三种不进入模型上下文的 custom entry：

```text
pi-time-context/session-anchor
pi-time-context/activity-facts
pi-time-context/carrier-decision
```

这些 entry 只保存 epoch 毫秒、消息 entry ID、toolCallId、错误标记、策略快照和渲染决策。不会复制消息正文、工具参数或工具输出。

模型可见的绝对时间固定为 `YYYY-MM-DD HH:mm ±HH:mm`，包含数字 UTC 偏移但不包含秒、内部 ID 或上一活动的绝对完成时间。系统时钟回拨时仍可发送当前绝对时间，但会省略负的 elapsed。

## 缓存不变量

- 不修改 system prompt。
- 不回改历史 assistant。
- 不修改 session 中的原始消息。
- 只在 `context` 提供的出站消息副本开头插入独立的时间 text block。
- 已记录的 stamped/null 决策和显示时区不会因重试、重载或配置变化而重算。
- 不在 assistant tool call 与 toolResult 之间插入额外消息。

## 限制

- 不提供模型可调用的时间工具。
- 不进行独立的跨自然日检测；`sent_at` 已包含完整日期。
- 不提供定时唤醒、后台轮询或 TUI 时间面板。
- 无持久 session 文件时可正常运行，但不保证跨进程恢复。

## 开发验证

```bash
npm install --ignore-scripts
npm run validate
```
