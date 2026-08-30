# pi-time-context 完整实施方案

## 1. 项目概述

### 1.1 项目名称

- 扩展名称：`pi-time-context`
- npm 包名：`@sevten/pi-time-context`
- 扩展标识：`pi-time-context`
- 项目目录：`/home/lxx/pi-time-context`

`pi-time-context` 用于在不修改 Pi 原始会话消息、不改变 system prompt、尽量保持模型提示词缓存命中的前提下，为模型按需提供准确的现实时间和距离上一活动完成的间隔。

它与 `pi-stamp` 一类 TUI 时间戳扩展的职责不同：

- `pi-stamp` 面向用户界面展示，不把时间信息发给模型；
- `pi-time-context` 面向模型上下文：新会话首条 user 先注入一次基线时间，之后只在检查点到达时把时间元数据附加到新的出站载体。

### 1.2 目标

1. 让模型在长会话中以固定节奏获得完整日期和时间信息。
2. 由扩展精确计算时间差，不依赖模型进行跨天、跨时区或长时段心算。
3. 区分 assistant 生成、工具执行和上一活动完成后的空闲间隔。
4. 不修改 Pi 持久化的原始 user、assistant、toolResult 内容。
5. 不回改已经发送过的 assistant 消息，保持历史缓存前缀稳定。
6. 保证 `/resume`、`/reload`、`/fork`、`/clone` 和分支恢复后的时间逻辑一致。
7. 所有历史注入决策均可稳定重放，同一消息在后续请求中的模型可见表示逐字节一致。
8. 新会话第一条 user 消息使用与其他 carrier 相同的 `sent_at` 表示 T0，不引入专用的“会话开始”字段。

### 1.3 非目标

第一版不实现以下能力：

- 不提供 `time_delta` 模型工具；
- 不单独实现跨自然日检测，完整时间戳自身包含日期；
- 不修改 system prompt 注入动态时间；
- 不回改历史 assistant 消息；
- 不提供“允许回改 assistant”的可选配置；
- 不提供定时器、后台轮询或周期性唤醒；
- 不负责 TUI 时间戳展示、统计面板或分析仪表盘；
- 不依赖模型自行判断是否需要时间信息。

## 2. 已确定的设计原则

### 2.1 会话锚点 T0 永久不变

对于正常启用扩展后创建的新会话，`T0` 定义为：**本会话第一条 user 消息真正被 Pi agent 处理时的时间**。

对于启用扩展前已经存在的历史会话，无法在不篡改历史语义的情况下还原这个时间，因此使用单独标记为 `legacy_activation` 的内部迁移锚点。除 7.8 的迁移规则外，本文所称 T0 均指正常新会话的首条 user 处理时间。

它不是：

- session 文件创建时间；
- 扩展加载时间；
- 用户按下回车的时间；
- `/resume`、`/reload`、`/fork` 或 `/clone` 的执行时间。

生命周期规则：

| 操作 | T0 行为 |
|---|---|
| `/new` | 清空 T0，等待第一条 user 消息被处理时创建 |
| `/resume` | 恢复原 T0，不变更 |
| `/reload` | 恢复原 T0，不变更 |
| `/fork` | 继承原会话路径的 T0，不变更 |
| `/clone` | 继承原会话路径的 T0，不变更 |
| `/tree`/分支导航 | 使用当前分支继承的 T0 |

新 fork 文件的 session header 会有新的文件创建时间，但该时间不得作为 T0。

T0 是扩展内部的检查点锚点。对模型不暴露 `T0` 这一内部名称，也不使用 `conversation_started_at` 或 `session_started_at` 等专用字段；但会把 T0 的格式化时间值作为新会话第一条 user 的普通 `sent_at` 注入。由于此时对话历史为空，该时间自然就是模型可感知的对话开始时间。

fork/clone 后，原来的第一条 user 消息仍位于保留历史中，其 `sent_at` 按原决策逐字节重放。分支上的下一条新消息只按普通检查点规则处理，不再次声明会话开始时间。

### 2.2 采用确定性检查点

默认检查间隔为 30 分钟。检查点相位固定在 T0：

```text
T0 + 30m, T0 + 60m, T0 + 90m, ...
```

扩展不设置 timer。每当有新的模型请求载体时，按当前载体时间计算是否跨入了尚未处理的新检查区间。

### 2.3 只向新的出站载体注入

可作为时间信息载体的对象只有：

1. 新处理的 user 消息；
2. 尚未发给模型的新 toolResult。

统称为 `carrier`。

不把时间元数据回填到历史 assistant。gap 超过阈值时，只在当前 carrier 中提供代码计算好的 `elapsed_since_last_activity`，不再发送上一活动的绝对完成时间。

### 2.4 事实、决策和渲染分离

实现分为三层：

```text
事实层 TimeFacts
  记录真实发生的时间事件，不决定是否注入

决策层 StampLedger
  决定哪个 carrier 消费了哪个检查点，以及注入哪些固定数据

渲染层 ContextRenderer
  在 context hook 的消息副本上稳定重建时间字段
```

原始消息内容始终保持不变。

## 3. Pi 生命周期与时间语义

目标兼容版本为 `@earendil-works/pi-coding-agent@0.80.3`。开发时不得依赖该版本不存在的 `agent_settled` 等新 API。

### 3.1 用户处理时间

监听：

```text
message_end(role = user)
```

处理函数执行时调用 `Date.now()`，得到 `userProcessedAt`。

Pi 对初始 prompt 和排队的 steering/follow-up 消息，都会在消息真正进入 agent loop 时触发 user `message_start/message_end`。因此这个时间代表“Pi 开始处理该用户消息”，而不是键盘提交时间。

第一条 user `message_end` 同时负责建立 T0。

这里的 user `message_end` 不是“整轮 assistant 回答结束”。对于 user 消息，它在该 user 消息被 agent loop 接收后立即触发，并且早于本轮首次 `context` hook。Pi 0.80.3 中相关顺序为：

```text
user message_start
→ user message_end（扩展在此记录 T0）
→ Pi 持久化原始 user message
→ context hook（扩展在此给出站副本追加 sent_at）
→ provider request
→ assistant message_start / update / end
```

因此，T0 虽然在 user `message_end` 中产生，仍然能赶在第一条 user 首次发送给模型之前，通过紧随其后的 `context` hook 注入该消息的模型可见副本。

### 3.2 assistant 时间

记录以下边界：

| 字段 | 事件 | 含义 |
|---|---|---|
| `requestedAt` | `context` | 本次模型调用开始构建出站上下文的本地时间 |
| `streamStartedAt` | assistant `message_start` | Pi 收到 provider response stream 开始事件的时间 |
| `firstContentAt` | 首个有效 assistant `message_update` | 首段非空 text、thinking 或 tool call 内容出现时间 |
| `completedAt` | assistant `message_end` | 完整 assistant 消息流结束时间 |

Pi 自带的 `assistant.timestamp` 在 provider 创建 response stream/message 时生成，不能当作输出完成时间。

用于判断上一活动结束点的权威字段是 `completedAt`。

可派生：

```text
totalDurationMs     = completedAt - requestedAt
streamDurationMs    = completedAt - streamStartedAt
firstContentDelayMs = firstContentAt - requestedAt
```

这些派生值首先用于内部事实记录。第一版模型注入只在必要时使用上一活动的 `completedAt` 和 gap，不默认发送完整性能指标。

### 3.3 工具时间

监听：

```text
tool_execution_start
tool_execution_end
```

以 `toolCallId` 精确配对：

```text
toolDurationMs = completedAt - startedAt
```

`tool_execution_end` 代表工具执行及 `tool_result` hook 后处理完成。它比 toolResult 消息自带的 timestamp 更适合作为工具完成时间。

并行工具必须注意：

- `tool_execution_end` 按实际完成顺序出现；
- toolResult 消息可能在整批工具完成后按源码调用顺序创建；
- 不能用 toolResult 的消息顺序或原生 timestamp 推断真实完成先后；
- 一批并行工具中，`completedAt` 最大的工具是该批次最后完成的活动。

### 3.4 上一活动定义

`previousActivity` 是当前 carrier 之前，按 `completedAt` 排序后最近完成的活动：

- assistant 完整输出；
- 工具执行；
- 已完成并成为历史事实的 toolResult 所代表的工具活动。

对于 user carrier，上一活动通常是最终 assistant 回复，也可能是以工具结果终止的任务。

对于 toolResult carrier，上一活动可能是触发工具的 assistant 消息，也可能是同一批/顺序工具中更早完成的工具。

## 4. 检查点与注入算法

### 4.1 检查区间编号

```typescript
const firstSentAtMs = clock.now();
const currentCheckpointIndex = Math.floor(
  (firstSentAtMs - sessionAnchor.t0Ms) /
    sessionAnchor.policy.checkpointIntervalMs,
);
```

默认：

```text
lastStampedCheckpointIndex = 0
```

新会话第一条 user 是特殊的基线 carrier：无论检查点是否到期，都固定使用 `T0` 作为 `firstSentAtMs` 并注入一次 `sent_at`。该基线注入同时消费区间 0，因此初始 `lastStampedCheckpointIndex = 0`。

此后 T0 后前 30 分钟仍属于区间 0，不重复注入；到达 T0 + 30 分钟后进入区间 1，才产生下一次普通检查点注入。

### 4.2 是否具备搭便车资格

```typescript
const checkpointDue =
  currentCheckpointIndex > lastStampedCheckpointIndex;
```

若从区间 2 直接跨到区间 8，只注入一条，并在成功创建决策后直接记录：

```text
lastStampedCheckpointIndex = 8
```

不补发区间 3～7 的时间戳。

### 4.3 carrier 首次发送原则

每个 carrier 只能在**第一次发给模型之前**决定是否带时间戳。

如果同一个 carrier 已经发过一次，即使 retry 时跨过了新的检查点，也不能给它追加新的时间字段，否则会改变已发送过的提示词后缀并降低缓存命中。

规则：

```text
新会话第一条 user
  → 固定生成只带 sent_at 的基线决策，firstSentAtMs = T0

新 carrier + checkpointDue
  → 生成带 stamp 的不可变决策

新 carrier + !checkpointDue
  → 生成不带 stamp 的不可变决策

已存在决策的 carrier
  → 原样重放该决策，不重新判断
```

如果 retry 期间检查点到达，但当前 carrier 已经决定不注入，则资格保持 pending，等待下一个新 carrier。

### 4.4 第二层 gap 判断

仅在当前 carrier 已满足搭便车条件时判断：

```typescript
const firstSentAtMs = clock.now();
const gapMs =
  firstSentAtMs - previousActivity.completedAtMs;

const includeElapsed =
  gapMs > sessionAnchor.policy.previousActivityThresholdMs;
```

默认阈值为严格的大于 30 分钟：

- `gap === 30分钟`：只注入 `sent_at`；
- `gap > 30分钟`：额外注入扩展计算好的 `elapsed_since_last_activity`，不发送上一活动的绝对完成时间。

当 carrier 是 user 时，gap 表示上一活动完成到用户消息被处理之间的间隔。

当 carrier 是 toolResult 时，gap 表示上一活动完成到当前工具完成之间的间隔，通常反映工具执行阶段耗时。

### 4.5 完整伪代码

```typescript
function decideForCarrier(carrier: Carrier): CarrierDecision {
  const existing = decisionByCarrierEntryId.get(carrier.entryId);
  if (existing) return existing;

  const isBaselineCarrier = isFirstUserOfNewConversation(carrier, anchor);
  const firstSentAtMs = isBaselineCarrier
    ? anchor.t0Ms
    : clock.now();
  const checkpointIndex = Math.floor(
    (firstSentAtMs - anchor.t0Ms) /
      anchor.policy.checkpointIntervalMs,
  );

  const checkpointDue =
    checkpointIndex > lastStampedCheckpointIndex;

  if (!isBaselineCarrier && !checkpointDue) {
    return persistDecision({
      carrierEntryId: carrier.entryId,
      firstSentAtMs,
      checkpointIndex,
      stamp: null,
    });
  }

  const previous = isBaselineCarrier
    ? undefined
    : findPreviousCompletedActivity(carrier);
  const gapMs = previous
    ? firstSentAtMs - previous.completedAtMs
    : undefined;

  const includeElapsed =
    previous !== undefined &&
    gapMs !== undefined &&
    gapMs > anchor.policy.previousActivityThresholdMs;

  const decision = persistDecision({
    carrierEntryId: carrier.entryId,
    firstSentAtMs,
    checkpointIndex,
    stamp: {
      renderVersion: anchor.policy.renderVersion,
      previousActivityKey: includeElapsed ? previous.key : undefined,
      elapsedMinutes: includeElapsed
        ? roundElapsedMinutes(gapMs)
        : undefined,
    },
  });

  lastStampedCheckpointIndex = Math.max(
    lastStampedCheckpointIndex,
    checkpointIndex,
  );
  return decision;
}
```

只有决策成功持久化后，才更新内存中的 `lastStampedCheckpointIndex`。

对于已有历史、但此前未启用本扩展的会话，首个新 carrier 也会建立一个迁移基线并注入普通 `sent_at`，但它不表示原对话的开始时间，详见 7.8。

## 5. 模型上下文注入格式

### 5.1 注入位置

使用 Pi `context` hook，对 `event.messages` 的深拷贝做非破坏性变换。

- user carrier：在其出站 content 开头插入一个独立的时间 text block；
- toolResult carrier：在其出站 content 开头插入一个独立的时间 text block；
- 不创建插在 assistant tool call 与 toolResult 之间的额外消息；
- 不修改历史 assistant；
- 不修改持久化原始消息；
- 不修改 system prompt。

### 5.2 注入格式

不使用 XML 标签、JSON、括号或额外的 metadata wrapper，只注入简单的 key-value 文本。

普通检查点只注入：

```text
sent_at: 2026-08-22 14:15
```

新会话第一条 user 也使用完全相同的格式：

```text
sent_at: 2026-08-22 14:15
```

不使用 `conversation_started_at`。模型已经能从“此前没有对话历史”判断这是第一轮，无需用专用字段重复表达；统一字段也避免 fork、clone 和旧会话迁移产生两套时间语义。

当 gap 严格大于阈值时增加一行：

```text
sent_at: 2026-08-22 14:15
elapsed_since_last_activity: 35分钟
```

`elapsed_since_last_activity` 表示当前 carrier 被处理/发送的时间减去上一 assistant 或工具活动的完成时间。它只在 gap 超过阈值且时钟数据有效时出现。

不发送上一活动的绝对完成时间。扩展已经计算出 elapsed，`previous completed` 对模型推理属于冗余信息。

### 5.3 格式要求

1. 本地事实统一保存为 UTC epoch milliseconds，阈值和 gap 判断保持毫秒精度。
2. 创建 T0 时解析并冻结 session 的 IANA 显示时区，但不把时区名称或 UTC offset 发给模型。
3. 模型可见的绝对时间固定为 `YYYY-MM-DD HH:mm`，只精确到分钟。
4. 模型可见的 elapsed 固定为整分钟中文格式，如 `35分钟`、`2小时15分钟`。
5. elapsed 使用固定的整分钟四舍五入规则；内部是否超过阈值仍以原始毫秒值判断。
6. 不把 tool 参数、tool 输出、用户内容或 assistant 内容复制进时间字段。
7. 不向模型暴露内部 session entry ID、toolCallId、时区配置或存储路径。
8. 字段顺序固定：第一行永远是 `sent_at`，可选第二行永远是 `elapsed_since_last_activity`；不存在 `conversation_started_at` 等第三种模型可见字段。
9. 已产生的决策必须在所有后续 context 调用中渲染为完全相同的字符串。

### 5.4 系统时钟异常

若发现：

```text
firstSentAtMs < previousActivity.completedAtMs
```

说明系统时钟可能回拨。此时：

- 仍可注入当前绝对时间；
- 不输出负数或钳制为 0 的 gap；
- 省略 `elapsed_since_last_activity`，只保留 `sent_at`；
- 在本地事实/诊断中记录 `clockAnomaly: "backwards"`；
- 不把诊断堆栈或内部错误发送给模型。

## 6. 缓存不变量

以下规则属于实现验收的强制条件。

### 6.1 不改变 system prompt

扩展不得在 `before_agent_start` 返回动态 `systemPrompt`。T0、当前时间和所有动态字段只进入新的 carrier 后缀。

### 6.2 不回改历史消息

模型已经见过的 user、assistant 和 toolResult 的模型可见表示不得在后续请求中改变。

特别禁止：

- 给上一条 assistant content 追加时间戳；
- 在 thinking/tool-call assistant 中插入时间文本；
- 对已发出但当时未注入的 carrier 在 retry 时补注入。

### 6.3 决策不可变

一个 carrier 的决策一旦持久化：

- `stamp: null` 永远保持不注入；
- 有 stamp 时，其 `sent_at`、可选 elapsed、显示时区和格式版本永远不变；
- 配置变化不得重算历史决策；
- `/reload` 和 `/resume` 后必须逐字节复现。

### 6.4 策略快照按会话冻结

以下策略在创建 T0 时写入 session anchor：

- `checkpointIntervalMs`；
- `previousActivityThresholdMs`；
- `timeZone`；
- `renderVersion`。

配置文件后续发生变化，只影响尚未建立 T0 的新 session。第一版不在活动 session 中改变检查点相位或历史渲染格式。

## 7. 持久化设计

### 7.1 custom entry 类型

```text
pi-time-context/session-anchor
pi-time-context/activity-facts
pi-time-context/carrier-decision
```

这些 custom entry 不进入模型上下文。

### 7.2 SessionAnchorV1

```typescript
interface SessionAnchorV1 {
  version: 1;
  t0Ms: number;
  origin: "first_user_processed" | "legacy_activation";
  policy: {
    checkpointIntervalMs: number;
    previousActivityThresholdMs: number;
    timeZone: string;
    renderVersion: 1;
  };
}
```

首次 user `message_end` 时：

1. 取 `Date.now()`；
2. 创建内存 anchor，并把当前 user 标记为待建立基线决策的首条 user；
3. 立即 `pi.appendEntry()` 持久化 anchor；
4. handler 返回后，Pi 持久化原始 user message；
5. 随后的首次 `context` hook 从内存/anchor 读取 `t0Ms`，定位刚持久化的首条 user entry；
6. 为该 user 创建不可变的 stamped carrier decision，其中 `firstSentAtMs = t0Ms`；
7. 仅在 `event.messages` 深拷贝中的该 user 开头插入独立的 `sent_at` text block，再把变换后的上下文交给模型。

`t0Ms` 已能无损表示时间，因而不重复存储可由它派生的 `t0Iso`。正常新会话的 `origin` 为 `first_user_processed`。

这样 anchor 位于第一条 user message 之前。第一条 user 随后的 carrier decision 使用 `t0Ms` 渲染普通 `sent_at`。fork/clone 保留该首条 user 时，必须同时补全并重放原 anchor 和 decision；分支的新 user 不生成第二个基线注入。

也就是说，记录时间和注入文本是两个连续 hook 的职责，不要求在 `message_end` handler 内直接改写 user 内容：

```text
message_end：确定并冻结事实 T0
context：把已冻结的 T0 渲染为 sent_at，注入首条 user 的出站副本
```

这种拆分既能让第一条消息首次请求就携带时间，又不会把时间焊死进 Pi 持久化的原始 user content。

### 7.3 ActivityFactsV1

按 turn 批量持久化，避免每个事件写一行 JSONL：

```typescript
interface ActivityFactsV1 {
  version: 1;
  activities: Array<
    | {
        key: string;
        kind: "user";
        messageEntryId: string;
        processedAtMs: number;
      }
    | {
        key: string;
        kind: "assistant";
        messageEntryId: string;
        requestedAtMs?: number;
        streamStartedAtMs?: number;
        firstContentAtMs?: number;
        completedAtMs: number;
      }
    | {
        key: string;
        kind: "tool";
        toolCallId: string;
        toolResultEntryId?: string;
        startedAtMs: number;
        completedAtMs: number;
        isError: boolean;
      }
  >;
}
```

持久化内容不得包含消息正文、工具参数或工具结果。

### 7.4 CarrierDecisionV1

```typescript
interface CarrierDecisionV1 {
  version: 1;
  carrierEntryId: string;
  carrierKind: "user" | "tool_result";
  firstSentAtMs: number;
  checkpointIndex: number;
  stamp:
    | null
    | {
        renderVersion: 1;
        previousActivityKey?: string;
        elapsedMinutes?: number;
      };
}
```

`previousActivityKey` 仅用于本地事实关联和诊断，不参与模型渲染。模型只看到由 `firstSentAtMs` 生成的 `sent_at`，以及由 `elapsedMinutes` 生成的可选 `elapsed_since_last_activity`。

即使某个 carrier 不需要注入，也必须持久化 `stamp: null`，用于证明它已经发给模型，避免 retry 时回填动态时间。

### 7.5 message ID 关联

Pi `0.80.3` 的扩展 `message_end` 事件不直接提供 session entry ID。

处理方式：

1. 在消息事件中暂存时间和消息身份特征；
2. Pi 在扩展事件返回后持久化消息；
3. 在后续 `context` 或 `turn_end` 中扫描 `ctx.sessionManager.getBranch()`；
4. 按 role、原生 message timestamp、toolCallId 和对象特征匹配对应 session message entry；
5. 持久化事实时使用最终 entry ID。

工具优先使用稳定的 `toolCallId`。不能把 `turnIndex` 当全局 ID，因为它会在新的 agent run 中重置。

### 7.6 分支引用规则

恢复状态时不能简单地使用所有 custom entry，也不能只依赖 custom entry 自身是否位于当前分支。

正确规则：

1. 取当前 message branch 上的所有 message entry ID；
2. 从 metadata entry 中选出引用这些 message ID/toolCallId 的事实和决策；
3. 忽略只引用其他分支消息的 metadata；
4. `lastStampedCheckpointIndex` 取当前分支有效 stamped decision 的最大值。

这是因为 carrier decision 通常在 carrier message 之后追加。若 `/clone` 精确停在该 message，decision 可能不在新文件复制路径中，但仍是该 message 首次发送时已经发生的事实。

### 7.7 fork/clone 尾部元数据补全

`session_start.reason === "fork"` 时：

1. 读取新 session 当前分支保留的 message IDs；
2. 读取 `previousSessionFile` 中引用这些 IDs 的 `pi-time-context` metadata；
3. 对新文件中缺失的 anchor、facts、decisions 做幂等复制；
4. 不复制引用未保留消息的 metadata；
5. 不生成新的 T0 或重新计算旧决策。

同一文件内的 `/tree` 导航可从 `getEntries()` 找到 metadata，但仍必须按当前分支 message ID 过滤。

### 7.8 老会话兼容

若扩展加载到一个没有 session anchor 的已有会话：

- 若当前会话还没有 user message：等待第一条 user 被处理后创建正常 T0；
- 若已有 user message：不使用历史 entry timestamp 伪造原会话的处理开始时间，也不回填任何历史消息；
- 等待扩展接管后的第一个新 carrier，在它首次发送时以当前 `firstSentAtMs` 建立迁移 anchor；
- 迁移 anchor 的 `origin` 记录为 `legacy_activation`，仅作为后续检查点的内部相位基线，不声称是原对话的真正开始时间；
- 该首个新 carrier 注入普通 `sent_at` 并消费区间 0，不注入 `conversation_started_at`；
- anchor 和该 carrier 的决策一旦建立便永久不变，后续 resume/reload/fork/clone 均稳定继承。

由于字段始终叫 `sent_at`，模型会把它理解为当前新消息的处理/发送时间；已有历史本身已经表明它不是会话首轮，不会产生“会话此刻才开始”的错误暗示。

## 8. context hook 处理流程

每次 `context` 事件执行：

```text
1. 恢复 anchor；新会话由第一条 user 的 message_end 建立正常 T0，旧会话则在首个新 carrier 处建立迁移 anchor
2. 恢复当前分支相关的 facts 和 carrier decisions
3. 定位本次出站请求的 carrier
4. 解析 carrier 对应的 session entry ID
5. 若 carrier 已有 decision：直接重放
6. 若 carrier 是正常新会话第一条 user：以 T0 创建固定的基线 stamped decision
7. 若其他 carrier 无 decision：在首次发送前按检查点计算并持久化 decision
8. 若 decision.stamp 为 null：不修改消息副本
9. 若有 stamp：生成固定时间字段并追加到 carrier 的 content 副本
10. 返回新的 messages 数组
```

### 8.1 carrier 定位

默认取本次请求末端尚未产生决策的最新有效 user/toolResult：

- 普通用户轮次：最新 user；
- 工具继续轮次：本批 toolResult 中实际 `completedAt` 最晚的结果；
- 并行工具：按 facts 的完成时间选，不按数组顺序选；
- retry：若末端 carrier 已有 decision，则只重放，不生成新决策；
- 没有新 carrier：不注入、不消费检查点。

### 8.2 content 变换

兼容两种 user content：

- 字符串 content：转换为 text content 数组，再在开头插入时间 text block；
- text/image content 数组：保持现有块和顺序，在开头插入时间 text block。

toolResult 保持已有 text/image 内容和顺序不变，只在开头插入时间 text block。

不得原地修改 `event.messages` 中的共享对象；应复制目标 message 和 content 数组后返回。

## 9. 配置设计

第一版配置项：

```json
{
  "checkpointIntervalMinutes": 30,
  "previousActivityThresholdMinutes": 30,
  "timeZone": "local"
}
```

建议路径：

| 路径 | 作用域 |
|---|---|
| `~/.pi/agent/pi-time-context.json` | 全局默认 |
| `<project>/.pi/pi-time-context.json` | 当前项目覆盖 |

规则：

- project 字段覆盖 global 同名字段；
- 缺失文件使用默认值；
- 非法值告警并退回有效值，不阻止扩展启动；
- 时间间隔必须是有限正数，并设置合理上下限；
- `timeZone` 必须是 `local`、`UTC` 或受 `Intl` 支持的 IANA 时区；
- `local` 在创建 T0 时解析为具体 IANA 时区并写入 anchor；
- anchor 创建后策略冻结，配置变化只影响新 session。

第一版不需要文件 watcher；运行中的 session 不热切换策略。

## 10. 项目结构

建议目录结构：

```text
pi-time-context/
├── package.json
├── tsconfig.json
├── README.md
├── CHANGELOG.md
├── IMPLEMENTATION_PLAN.md
├── src/
│   ├── index.ts              # 扩展入口和事件注册
│   ├── types.ts              # 持久化 schema 和运行时类型
│   ├── clock.ts              # 时钟接口、ISO/时区格式化、异常检查
│   ├── checkpoint.ts         # bucket 和 gap 决策纯函数
│   ├── state.ts              # anchor/facts/decision 恢复和索引
│   ├── persistence.ts        # custom entry 读写与版本兼容
│   ├── activity-tracker.ts   # user/assistant/tool 生命周期采集
│   ├── carrier.ts            # carrier 定位和 entry ID 关联
│   ├── renderer.ts           # 稳定时间字段序列化
│   ├── context-transform.ts  # 非破坏性消息副本注入
│   └── config.ts             # 配置加载、合并和验证
└── tests/
    ├── checkpoint.test.ts
    ├── clock.test.ts
    ├── renderer.test.ts
    ├── activity-tracker.test.ts
    ├── carrier.test.ts
    ├── persistence.test.ts
    ├── context-transform.test.ts
    └── lifecycle.test.ts
```

## 11. 测试方案

### 11.1 检查点单元测试

- 新会话第一条 user 在 bucket 0 固定注入 `sent_at`；
- 第一条 user 之后、T0 后 29:59.999 内的 carrier 不重复注入；
- T0 后 29:59.999 不触发；
- T0 后正好 30:00 触发 bucket 1；
- 同一 bucket 多个 carrier 只注入一次；
- 从 bucket 2 跳到 bucket 8 只注入一条；
- 注入后 `lastStampedCheckpointIndex` 直接变为 8；
- exact 30-minute gap 不带 `elapsed_since_last_activity`；
- gap 大于 30 分钟 1ms 时带 `elapsed_since_last_activity`；
- 系统时钟回拨不生成负 gap。

### 11.2 时间事件测试

- 第一条 user `message_end` 建立 T0；
- queued user 以被 agent 消费时间为 processedAt；
- assistant `message_end` 被记录为 completedAt；
- assistant 原生 timestamp 不被误用为完成时间；
- first content 只记录首个有效 text/thinking/tool-call update；
- tool start/end 按 toolCallId 配对；
- 工具错误仍记录完成时间和 `isError`；
- 并行工具按真实完成时间排序。

### 11.3 缓存稳定测试

- context transform 前后的持久化原始消息深度相等；
- 历史 assistant 逐字节不变；
- 时间字段只出现在新 user/toolResult 副本；
- 第一条 user 的 `sent_at` 始终由不可变 T0 逐字节重建；
- 同一 stamped carrier 多次 context 调用生成完全相同字符串；
- 同一 unstamped carrier 在晚到检查点的 retry 中仍不注入；
- 更换配置后旧决策不改变；
- system prompt 不发生变化；
- 已缓存历史前缀直到新 carrier 之前保持一致。

### 11.4 生命周期测试

- `/new` 等到第一条 user 才建立新 T0，并在该 user 上注入普通 `sent_at`；
- `/resume` 保持 T0；
- `/reload` 保持 T0 和所有 decision；
- `/fork` 继承 T0，并重放保留的首条 user 原有 `sent_at`；
- fork 分支的下一条新 user 不生成第二个“会话开始”基线，只按普通检查点判断；
- `/clone` 精确停在 carrier 时补全其旧 decision；
- `/tree` 只恢复当前分支相关 metadata；
- fork 到早期分支不会继承后续 checkpoint decision；
- compaction 后检查点状态仍可恢复；
- 老会话不改写历史，在首个新 carrier 建立 `legacy_activation` anchor 并注入普通 `sent_at`；
- `legacy_activation` anchor 建立后不再改变，也不被当作原对话开始时间。

### 11.5 工具协议测试

- assistant tool call 与 toolResult 的相对顺序不变；
- 不在两者之间插入 custom user message；
- toolResult 原内容、图片、错误状态和 details 不被修改；
- 只修改发送给模型的 content 副本；
- 并行多 toolResult 只选择一个 carrier；
- 大型 toolResult 不被复制进 metadata。

### 11.6 持久化与容错测试

- 未知 entry version 被忽略并告警；
- 损坏 entry 不阻断会话；
- 重复 decision 幂等选择最早的有效记录；
- fork metadata 补全不会重复写入；
- 缺失 previous activity 时仍可只注入 `sent_at`；
- Date.now 返回无效/回拨值时安全降级；
- in-memory session 正常运行但不承诺跨进程恢复。

## 12. 实施阶段

### 阶段一：项目脚手架和纯函数

1. 创建 `package.json`、`tsconfig.json`、README 基础结构；
2. 实现 clock abstraction，测试使用 fake clock；
3. 实现 checkpoint、gap 和稳定 formatter；
4. 完成纯函数单元测试。

交付标准：不连接 Pi 事件也能完整验证所有时间判断边界。

### 阶段二：时间事实采集

1. 注册 user/assistant message 生命周期事件；
2. 注册 tool execution 生命周期事件；
3. 实现并行工具配对；
4. 实现 turn facts 批量持久化；
5. 建立 T0 anchor。

交付标准：运行真实 Pi 会话后，session JSONL 中存在不含正文的准确时间事实。

### 阶段三：状态恢复和分支语义

1. 实现 anchor/facts/decision 版本解析；
2. 基于当前 branch message IDs 恢复有效状态；
3. 实现 resume/reload；
4. 实现 fork/clone 尾部 metadata 补全；
5. 实现老会话 fallback。

交付标准：所有 session 生命周期测试通过，T0 永不漂移。

### 阶段四：carrier 决策与模型注入

1. 定位 user/toolResult carrier；
2. 持久化 stamped/unstamped decision；
3. 实现时间字段稳定渲染；
4. 在 context 副本中注入；
5. 验证 retry、并行工具和缓存前缀不变量。

交付标准：真实请求中，模型在首条 user 看到一次基线 `sent_at`，之后只在检查点看到新的 `sent_at` 和可选 elapsed；历史 assistant 和 system prompt 不变。

### 阶段五：配置、文档和发布验证

1. 实现全局/项目配置加载；
2. 编写安装、配置、行为和限制文档；
3. 增加 CHANGELOG；
4. 执行 typecheck、全部测试和 `npm pack --dry-run`；
5. 用至少一个纯文本回复、一个顺序工具、一个并行工具会话做人工验证。

交付标准：包可由 Pi 直接安装，默认配置无需额外操作即可工作。

## 13. 验收标准

以下条件全部满足才视为第一版完成：

1. T0 取第一条 user 被处理时间，并在 resume/reload/fork/clone 后保持不变。
2. 新会话第一条 user 固定以普通 `sent_at` 注入 T0，不使用 `conversation_started_at` 或其他专用字段。
3. 默认每跨过一个 30 分钟区间，在下一个新 carrier 上注入一次。
4. 跨越多个区间只注入一条。
5. carrier 同时支持 user 和 toolResult。
6. assistant 完成时间来自 assistant `message_end`。
7. 工具完成时间来自 `tool_execution_end`，并行工具按 toolCallId 正确配对。
8. gap 基于上一活动 `completedAt`，不包含 assistant 已完成前的生成时间。
9. 仅当 gap 严格大于 30 分钟时才增加 `elapsed_since_last_activity`。
10. 不回改任何历史 assistant。
11. 不改变 system prompt。
12. 不修改 Pi 持久化的原始消息内容。
13. stamped 和 unstamped decision 均可持久化并稳定重放。
14. retry 不会给已发出的 carrier 动态补时间戳。
15. 历史时间字段在 reload/resume/fork/clone 后逐字节一致。
16. 普通注入严格使用单行 `sent_at: YYYY-MM-DD HH:mm`。
17. 超阈值时只增加 `elapsed_since_last_activity`，不发送标签、JSON、秒、显式时区或上一活动绝对时间。
18. 老会话不回填历史时间，只从首个新 carrier 建立并冻结迁移基线。
19. 不实现独立跨天检测和 `time_delta` 工具。
20. 全部单元、生命周期、持久化和协议测试通过。
21. TypeScript 类型检查及 npm 打包检查通过。

## 14. 主要风险与控制措施

| 风险 | 控制措施 |
|---|---|
| 回改历史导致缓存失效 | 只向首次发送的新 carrier 注入 |
| assistant 原生 timestamp 不是完成时间 | 使用 assistant `message_end` 本地时间 |
| 并行工具 timestamp 失真 | 使用 tool_execution_start/end + toolCallId |
| retry 时动态改变同一 carrier | 每个 carrier 首次发送即持久化 stamped/null decision |
| fork/clone 丢失尾部 metadata | 按 retained message ID 从 previousSessionFile 幂等补全 |
| fork 后重复声明会话开始 | 保留并重放原首条 user 的 `sent_at`，分支新消息只走普通检查点 |
| branch 混入其他路径状态 | metadata 必须按当前 branch message IDs 过滤 |
| 配置变化重写历史 | 策略在 T0 创建时按 session 冻结 |
| 系统时钟回拨 | 省略负 gap，保留绝对时间并记录本地异常 |
| 工具协议被额外消息打断 | 时间字段直接附加到 toolResult 出站副本 |
| 元数据膨胀 | 活动事实按 turn 批量持久化，不存正文/参数/结果 |

## 15. 参考依据

- Pi extension `context` hook 会收到消息深拷贝，适合非破坏性出站变换。
- Pi 在 extension `message_end` handler 返回后才持久化原始消息。
- Pi assistant `message_end` 在完整 provider stream 结束后触发。
- Pi 工具提供独立的 `tool_execution_start` 和 `tool_execution_end` 事件。
- `pi-stamp` 的 assistant completion、first content、toolCallId 配对和 versioned custom entry 设计可作为事实采集层参考，但它不向模型注入时间信息：<https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-stamp>
