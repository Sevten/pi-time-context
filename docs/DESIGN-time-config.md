# 设计文档：`/time-config` 命令与时间戳可视化

状态：设计定稿，待实现
关联文档：`README.md`、`IMPLEMENTATION_PLAN.md`

## 1. 目标与范围

在 `pi-time-context` 扩展中新增：

1. **`/time-config` 命令**：快速查看与修改 `checkpointIntervalMinutes`、`previousActivityThresholdMinutes`、`timeZone` 三项配置，以及 `stampEveryMessage`（每条消息都附着时间戳）开关，支持写入**项目层**与**全局层**两个配置文件。
2. **会话内即时生效**：修改后不要求重启会话，对**之后**发出的消息立即生效；已发送消息的时间戳不受影响。
3. **TUI 可视化（方案一）**：为已持久化的 carrier decision 注册 entry 渲染器，在聊天流中显示该消息附带的时间戳。
4. **辅助可见性（方案三）**：编辑器上方 widget 常驻显示当前时间与下次检查点时刻；`/time-config show` 列出当前配置与最近的决策记录。

明确不做：

- 不把时间戳写入持久化的 user / assistant / toolResult 消息内容（保持"发送时附着"的既有架构，见 README「How it works」）。
- 不做 markdown transformer 方案（无法可靠关联消息条目，详见第 8 节）。
- 不在会话进行中监听配置文件变化；文件修改仅对新会话生效。
- threshold 不与 interval 联动，各自独立配置。

## 2. 命令语法（方案 A）

```
/time-config                          → 交互式主菜单（无 UI 时提示）
/time-config show                     → 显示当前配置与最近决策
/time-config interval <分钟> [-g]      → 修改检查点间隔
/time-config every [-g]                → 切换"每条消息都附着"模式
/time-config threshold <分钟> [-g]     → 修改上一活动阈值
/time-config tz <IANA|local|UTC> [-g] → 修改时区
```

- `-g` / `--global`：写入全局层 `~/.pi/agent/pi-time-context.json`；缺省写入项目层 `<cwd>/.pi/pi-time-context.json`。
- 参数非法时通过 `ctx.ui.notify` 给出具体原因（复用 `config.ts` 现有校验规则：分钟数为 1–10080 的有限数；时区须为 `local`、`UTC` 或可解析的 IANA 名称）。`/time-config interval <分钟>` 隐含关闭 `stampEveryMessage`；`/time-config every` 为布尔开关，重复执行即切换。
- 命令名注册为 `time-config`，无别名。

## 3. 交互式菜单（方案 B）

无参数时（且 `ctx.mode === "tui"`）进入交互流程：

1. **主菜单**（`ctx.ui.select`）：
   - `interval — 检查点间隔（当前 30 分钟 / 每条消息）`
   - `threshold — 上一活动阈值（当前 30 分钟）`
   - `timeZone — 时区（当前 +08:00 / Asia/Shanghai）`
   - `show — 查看配置与最近决策`
2. **选择数值项后**（interval / threshold）：
   - `ctx.ui.select` 常用档位：`每条消息 / 5 / 10 / 15 / 30 / 60 / 120 分钟`，外加 `自定义…`；
   - 选择 `每条消息` 即置 `stampEveryMessage = true`（interval 值保留但不参与决策，便于切回）；
   - `自定义…` 走 `ctx.ui.input`，输入分钟数，校验失败就地提示并重试；
   - 随后 `ctx.ui.select` 选择写入层：`项目（.pi/pi-time-context.json） / 全局（~/.pi/agent/pi-time-context.json）`；
   - 成功后 `ctx.ui.notify` 结果，并附带一句生效语义说明（见第 5 节）。
3. **timeZone 项**：
   - `ctx.ui.select`：`local（跟随系统） / UTC / 自定义…`；
   - `自定义…` 走 `ctx.ui.input` 输入 IANA 名称，即时用 `resolveTimeZone` 校验，失败重试；
   - 同样选择写入层，notify 结果。
4. **改 interval 后**额外提示当前 threshold 值（两者独立、不联动，提示仅为避免困惑）。

## 4. 配置文件写入

- 写入即 merge：读取目标文件现有内容（不存在则 `{}`），仅覆盖本次修改的键，保留其余键与注释无关字段（JSON 无注释），写回格式化 JSON（2 空格缩进 + 结尾换行）。
- 项目层目录 `.pi/` 不存在则递归创建。
- 写入失败（权限、只读等）：notify 错误，**不产生策略修订、不改内存状态**。
- 优先级不变：新会话启动时 `loadConfig` 按默认值 → 全局层 → 项目层叠加，项目层覆盖全局层。
- 不自动修改 `.gitignore`；README 说明项目层文件可提交共享或自行忽略。

## 5. 会话内生效：策略修订（policy revision）

### 5.1 语义

- 会话启动时，文件配置（全局 + 项目叠加）作为 **revision 0**，`effectiveFromMs = T0`。
- 每次 `/time-config` 成功修改（无论写入哪一层文件）都追加一条修订：`{ config 快照, effectiveFromMs = 修改命令处理时刻 }`。修订是**全量快照**（三项配置的完整值），不是增量。
- carrier 决策时，取 `effectiveFromMs <= firstSentAtMs` 的最新修订作为本次决策使用的 policy。
- `stampEveryMessage = true` 时跳过分桶逻辑：只要该 carrier 首次发送即盖章（`checkpointDue` 恒为 true），checkpointIndex 仍按当前 interval 记录（仅供 show 展示）。从该模式切回普通间隔时采用同样的 **2a** 相位语义：新 interval 从 T0 重新分桶，若当前时刻已落入比上次盖章更新的 bucket，下一条消息会补一次注入（在每条消息模式下这通常不会发生，因为最后一条消息刚被盖过章，其 checkpointIndex 即为当前 bucket）。
- 相位语义采用 **2a**：新 interval 直接代入 `checkpointIndexAt = floor((t − T0) / newIntervalMs)`，从 T0 重新分桶。副作用：改小间隔后当前时刻可能立即落入新 bucket（`checkpointIndex > lastStampedCheckpointIndex`），从而在下一条消息上**补一次注入**——这是预期行为，notify 中说明。
- threshold、timeZone 的修订同样即时生效于下一次决策 / 渲染，无相位问题。
- 已冻结的 carrier decision 永不重算：重放、resume、fork、provider 重试时按已持久化的决策渲染。

### 5.2 持久化

- 新增 custom entry 类型 `POLICY_REVISIONS_ENTRY`（常量名与 `CARRIER_DECISION_ENTRY` 等并列，放在 `types.ts`），每次修订 append 一条，data 结构：

  ```jsonc
  {
    "version": 1,
    "effectiveFromMs": 1760000000000,   // 修订生效时刻（epoch ms）
    "policy": {                          // 全量快照，字段同 SessionAnchorV1.policy
      "checkpointIntervalMs": 900000,
      "previousActivityThresholdMs": 1800000,
      "timeZone": "Asia/Shanghai",
      "renderVersion": 1,
      "stampEveryMessage": false
    },
    "source": "command",                 // 预留：命令来源修订
    "scope": "project"                   // 本次文件写入目标层，仅作记录
  }
  ```

- `persistence.ts` 新增 `parsePolicyRevision(data, warn)`，校验规则参照 `parseSessionAnchor`：`version === 1`、`effectiveFromMs` 为合法 epoch、policy 字段校验同 anchor（`stampEveryMessage` 为布尔值）。解析失败丢弃该条并告警，不影响其他修订。旧会话的 anchor 中无此字段，按 `false` 处理（向后兼容）。
- 恢复：resume / reload 时按 entry 顺序收集全部修订，按 `effectiveFromMs` 升序排列；与 revision 0 合并后供决策查询。快照式存储使得中间某条损坏也不影响前后条目。
- revision 0 的来源仍是文件配置快照（anchor 中已有 `policy`，可复用），修订条目只记录变更。

### 5.3 决策流程改动

`createCarrierDecision` 的输入由单一 `anchor`（内含 policy）改为 `resolvePolicy(anchor, revisions, firstSentAtMs)` 的返回值；`checkpointIndexAt`、`includeElapsed` 判断、渲染时区均使用解析后的 policy。函数签名向后兼容的做法：`revisions` 缺省为空数组时行为与现状完全一致。

## 6. TUI 可视化

### 6.1 决策 entry 渲染器（方案一，已实现）

自扩展目标版本升级至 `pi-coding-agent@0.85.1` 起可用 `pi.registerEntryRenderer`，本节已实现（`src/visibility.ts`）：

- 在扩展加载时注册：

  ```ts
  pi.registerEntryRenderer(CARRIER_DECISION_ENTRY, (entry, { expanded }, theme) => { ... });
  ```

- 渲染规则：
  - `stamp === null`（未盖章的决策）：返回 `undefined`（不占行），保持聊天流干净；
  - 有 stamp：单行紧凑文本 `sent_at HH:MM +08:00 · 距上次活动 2小时15分钟`（无 elapsed 时省略后半段），文字用 theme 的 `dim` 色；时间戳按本机时区（`local`）渲染；
  - 已知限制：宿主在每个 custom entry 前固定插入一个空行（`CustomEntryComponent`），渲染器无法去除，故标记与消息之间有一个空行的间距。
  - `expanded` 时附加展示决策标识（carrier 条目 id、checkpoint bucket）；
  - 数据版本不为 1 的条目不渲染。
- 渲染仅为显示，`expanded` 之外不引入新数据读取；渲染函数保持同步、开销小。
- 历史会话 resume / reload 后，已持久化的决策 entry 自动获得同样的渲染。

### 6.2 状态栏（方案三）

原设计的编辑器上方 widget 已按用户要求移除，改为 footer 状态行：

- TUI 模式下用 `ctx.ui.setStatus("pi-time-context", "14:32 · 下次检查点 15:00")` 在窗口最底部的扩展状态行显示当前时间与下次检查点（每条消息模式只显示时间）；
- 更新时机：不做定时器（维持"无后台工作"原则）。在已有的事件点刷新：每次 carrier 决策后、每次 `/time-config` 执行后。两次事件之间的"现在时间"允许陈旧；
- 无 UI（print / json 模式）下跳过；
- 内容基于当前生效修订（`resolvePolicy`），修改配置后立即反映。

### 6.3 `/time-config show`（方案三）

输出（notify 或多行 widget/文本）：

- 当前生效配置：三项值 + 每项来源（默认 / 全局文件 / 项目文件 / 会话修订）；
- 下次检查点时刻；
- 最近 N 条（建议 5 条）已冻结决策：时刻、是否含 elapsed。

## 7. 事件与生命周期

- **命令注册**：`session_start`（或扩展加载）时 `pi.registerCommand("time-config", ...)`。
- **修订写入点**：命令 handler 内成功写文件后 `pi.appendEntry(POLICY_REVISIONS_ENTRY, ...)`，随后更新内存中的 revisions 列表与 widget。
- **决策查询点**：`transformContextMessages` 现有的关联流程不变，仅 policy 来源改为 `resolvePolicy`。
- **恢复点**：现有 session 加载/分支切换的恢复路径上，追加收集 `POLICY_REVISIONS_ENTRY`（复用读取 custom entries 的既有管道，`persistence.ts` 的 entries 扫描函数加一种类型）。
- fork / clone：custom entries 随会话树复制，修订自然继承；无需额外处理。

## 8. 已否决的备选方案（备忘）

- **时间戳写入对话历史**：污染原始消息、不可逆、renderVersion 无法重渲染、编辑/压缩需特殊处理；且决策逻辑一个都省不掉，只是把结果存错位置。
- **markdown transformer 实现消息上方显示**：transformer 签名无消息 entry id，只能按文本匹配关联决策；重复文本与 fork 场景会静默标错，违背确定性原则。
- **改 interval 采用"旧相位走完再切"（2b）**：需要叠加遗留状态，违背"改小间隔想更快看到时间戳"的意图，且无重放收益。
- **会话中监听配置文件**：与命令修订两套事实来源互相打架；文件仅作为新会话的初始值。

## 9. 测试计划

沿用 `tests/` 现有风格（vitest，纯函数 + 临时目录 fixture）：

1. **命令参数解析**：各子命令、`-g` 标志、缺参、非法值（0、负数、超上限、坏时区）的错误路径。
2. **文件写入**：merge 保留既有键；项目层目录创建；写入失败的传播；`-g` 写到正确路径。
3. **policy revision**：
   - `resolvePolicy` 在多修订下按 `effectiveFromMs` 选取正确快照；
   - 恰好在 `effectiveFromMs` 当刻的消息使用新修订（边界含等号）；
   - 修订条目损坏时跳过并告警；
   - 空 revisions 时行为与现状一致（回归）。
4. **相位 2a**：改小 interval 后当前时刻跨入新 bucket 时下一条消息立即注入；改大 interval 时不重复注入旧区间。
5. **每条消息模式**：开关打开后每个新 carrier（user 与 toolResult）均盖章；切回普通间隔后恢复分桶且不重复注入；旧 anchor / 旧修订缺该字段时按 false 兼容。
6. **渲染器**：stamp 为 null 不渲染；含/不含 elapsed 的文本；expanded 分支。
7. **show 输出**：来源标注正确（文件层 vs 会话修订），interval 项显示“每条消息”模式。
8. **端到端生命周期**：修改 interval → 新消息决策使用新 policy → resume 后修订恢复、重放渲染一致。

## 10. 实现拆分建议

1. `types.ts` + `persistence.ts`：`POLICY_REVISIONS_ENTRY`、`parsePolicyRevision`。
2. 新模块 `src/policy-revisions.ts`：`resolvePolicy`、修订列表管理。
3. `src/commands.ts`（新）：命令注册、参数解析、文件写入、交互菜单。
4. `src/visibility.ts`（新）：entry 渲染器与 widget。
5. `src/index.ts`：接线（注册命令/渲染器、恢复修订、决策流程改用 `resolvePolicy`）。
6. README 增补使用说明。
