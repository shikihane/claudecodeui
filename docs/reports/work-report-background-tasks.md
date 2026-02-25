# Work Report: Background Tasks & HITL Recovery Implementation

**Date:** 2026-02-21 ~ 2026-02-22
**Project:** Claude Code UI
**Design Doc:** `docs/plans/2026-02-21-background-tasks-hitl-recovery-design.md`

## Executive Summary

为 Claude Code UI 实现了完整的后台任务监控和 HITL（Human-in-the-Loop）权限恢复系统，共 6 个阶段。系统增强了可靠性和用户体验：防止页面刷新时权限请求丢失，并提供后台任务执行的可见性。

## Implementation Phases

### Phase 1: Core Infrastructure

**Backend:**
- 权限请求超时从 55 秒延长至 8 小时（`server/claude-sdk.js`）

**Frontend:**
- 断线自动重置连接状态（`useChatRealtimeHandlers.ts`）

### Phase 2: Permission Recovery

**Backend:**
- `pendingToolApprovals` 存储完整审批元数据
- `get-pending-permissions` WebSocket handler

**Frontend:**
- localStorage 持久化权限请求
- 重连后自动恢复权限状态
- 服务端与本地状态同步，过期请求检测

### Phase 3: Background Task Monitoring

**Backend:**
- `backgroundTasks` Map 任务元数据存储
- 检测 `run_in_background=true` 的 Task/Bash 工具调用
- 发送 `background-task-started` / `background-task-completed` 消息
- `query-task-output` WebSocket handler，支持输出截断

**Frontend:**
- `BackgroundTasksPopover` 组件：按钮 badge + 下拉面板
- Subagents / Bash 双标签页
- 任务状态指示器（running/completed）
- 输出显示与截断，5 秒轮询更新
- 响应式行数限制（移动端 50，桌面 200）

### Phase 4: Bug Fixes & Code Review

共 8 项修复（2 CRITICAL, 4 Important, 2 Suggestion）：

| Issue | Severity | Description |
|-------|----------|-------------|
| backgroundTasks Map 无限增长 | Important | 添加 100 上限 + FIFO 淘汰 |
| pending-permissions sessionId 校验 | Important | 过滤非当前会话的响应 |
| Bash 完成检测 | Important | `activeBashToolIds` Set + `bash-completed` 消息 |
| truncateOutput 重复定义 | Important | 提取为模块级函数 |
| 任务删除语义 | Important | "Kill" 改为 "Dismiss"，SDK 无法终止单个后台任务 |
| WebSocket 断线状态重置 | Important | 断线时重置 isLoading/canAbortSession/claudeStatus 等 |
| 内部 resolver 暴露 | Suggestion | 创建只读查询函数 `getPendingApprovalsForSession()` |

### Phase 5: UI & i18n Enhancement

- localStorage 竞态条件修复
- Popover 关闭时停止轮询
- 前端列表自动淘汰（最多 200 条）
- `BackgroundTasksPopover` 完整 i18n（en, zh-CN）
- `useMemo` 优化 isMobile 计算

### Phase 6: Additional Bug Fixes

| Bug | Status | Fix |
|-----|--------|-----|
| #1: Task ID 显示内部 toolUseId | FIXED | 时间戳+随机后缀生成友好 ID（`bash_17402xxx_a3f`） |
| #2: 子代理输出未捕获 | FIXED | `tool_result` handler 增加 Task 工具输出采集 |
| #3: 创建后台任务后 Agent 卡住 | ANALYZED | 确认为 SDK 级别的 UX/行为问题，非代码 bug |

## Files Changed Summary

**New files (6):**
- `src/components/app/BackgroundTasksPopover.tsx`
- `server/routes/commands.js`
- `src/i18n/locales/en/backgroundTasks.json`
- `src/i18n/locales/zh-CN/backgroundTasks.json`
- `docs/plans/2026-02-21-background-tasks-hitl-recovery-design.md`
- `test-skills.cjs`（测试辅助）

**Modified files (12):**
- `server/claude-sdk.js` — 核心 SDK 集成、任务追踪、权限存储
- `server/index.js` — WebSocket handlers、权限查询、后台任务管理
- `src/contexts/WebSocketContext.tsx` — 连接管理、消息订阅
- `src/components/app/AppContent.tsx` — 重连恢复
- `src/components/chat/hooks/useChatProviderState.ts` — localStorage 持久化
- `src/components/chat/hooks/useChatRealtimeHandlers.ts` — 状态同步
- `src/components/main-content/view/subcomponents/MainContentHeader.tsx`
- `src/components/sidebar/view/subcomponents/SidebarContent.tsx`
- `src/components/CommandMenu.jsx`
- `src/components/chat/hooks/useChatComposerState.ts`
- `src/components/chat/hooks/useSlashCommands.ts`
- `src/components/chat/tools/configs/toolConfigs.ts`

## Known Limitations

1. **TaskOutput 工具集成** — 占位实现，需要 SDK 增强
2. **后台任务终止** — SDK 不暴露终止单个后台任务的 API，目前仅从 UI 移除
3. **跨标签页同步** — 设计上不支持（复杂度过高）
