# 后台任务创建后 Agent 卡住 — 分析与解决方案

**Bug ID:** #3
**Severity:** HIGH
**Date:** 2026-02-22
**Status:** 已分析，已实施 workaround

## 现象

用户创建后台任务（`run_in_background=true`）后，Claude 卡在 "Reasoning..." 状态，持续 213+ 秒，UI 完全无响应。

## 根本原因

### 竞态条件：工具文档与实际行为不一致

1. **Bash 工具文档承诺：** "you'll be notified when it finishes"
2. **实际代码行为：** 后台任务被明确跳过完成通知

```javascript
// server/claude-sdk.js — 后台任务的完成通知被跳过
if (activeBashToolIds.has(toolUseId) && !backgroundBashToolIds.has(toolUseId)) {
  ws.send({ type: 'bash-completed', ... });
}
```

3. Claude 读取工具文档 → 看到"会收到通知" → 创建后台任务 → 等待通知 → 通知永远不来 → 无限 reasoning 循环

### 时间线

```
T=0ms    用户请求创建后台任务
T=10ms   Claude 调用 tool with run_in_background=true
T=20ms   SDK 立即返回 tool_result（任务 ID + 输出路径）
T=30ms   Claude 处理 tool_result，输出响应
T=40ms+  Claude 读取系统提示："会收到完成通知"
         → 决定等待通知
         → 通知永远不来（被代码跳过了）
         → 无限循环
```

## 已确认的 Debug 证据

```
[DEBUG] Background Bash task detected: tooluse_ROApa0EE3t2D52jwepPncU
[DEBUG] tool_result for background Bash task: tooluse_ROApa0EE3t2D52jwepPncU
[DEBUG] Received message #41-51, type: stream_event/result
Token budget from modelUsage: { used: 84094, total: 160000 }
```

后端代码流程正确（tool_use → 立即 tool_result → 任务后台运行），问题在 Claude SDK 的推理层。

## Related GitHub Issues

- [TaskOutput hangs after background agent completes #20236](https://github.com/anthropics/claude-code/issues/20236)
- [Background task completion does not trigger notification #20525](https://github.com/anthropics/claude-code/issues/20525)
- [run_in_background=true Task agents silently lose all output #17011](https://github.com/anthropics/claude-code/issues/17011)
- [Session freezes indefinitely when multiple background agents #17540](https://github.com/anthropics/claude-code/issues/17540)

## 方案评估

### 方案 A: 检测后自动中断会话（已实施）

检测到 `run_in_background=true` 后，等 Claude 输出完整响应，立即 abort 会话。

```javascript
if (backgroundTaskCreatedThisTurn && message.type === 'message') {
  if (messageData && messageData.stop_reason) {
    ws.send({ type: 'session-auto-aborted', reason: 'background_task_created' });
    queryInstance.abort();
    break;
  }
}
```

- **优点:** 简单直接，防止卡死
- **缺点:** 打断正常会话流程，可能丢失后续交互

### 方案 B: 系统提示词覆盖

在系统提示中明确覆盖工具文档的错误承诺，告诉 Claude：创建后台任务后立即结束 turn，不要等待通知。

- **优点:** 从根源解决，不打断会话
- **缺点:** 依赖 Claude 遵循指令，不能 100% 保证

### 方案 C: 超时检测 + 自动恢复

监控 SDK 消息流，超过 60 秒无新消息则自动中断，发送恢复提示。

- **优点:** 通用性强，适用于各种卡死场景
- **缺点:** 60 秒延迟，误判风险

### 方案 D: 并发会话（长期）

允许前端在等待时发送新消息到新会话，后端已支持多会话。

- **优点:** 最正确的架构方案
- **缺点:** 前端改动大

## 当前状态

- 方案 A 已在 `server/claude-sdk.js` 中实施作为 workaround
- 等待 Claude SDK 官方修复（上游 issue 已存在）
- 长期应考虑方案 D（并发会话）

## 教训

1. **工具文档的承诺必须与代码行为一致** — SDK 工具文档说"会通知"但代码跳过了通知
2. **不能假设 LLM 会忽略文档中的承诺** — Claude 会认真对待文档中的每一句话
3. **后台任务需要明确的完成信号** — 不能依赖隐式行为
