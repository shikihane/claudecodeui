# 后台任务监控与 HITL 恢复设计文档

**日期：** 2026-02-21
**状态：** 设计阶段
**预计工期：** 5-7 天

---

## 1. 概述

### 1.1 背景

当前 Claude Code UI 存在以下问题：

1. **HITL 中断问题**：页面重载或 WebSocket 断开时，权限请求（包括 AskUserQuestion）会丢失，导致工作流中断
2. **缺少后台任务监控**：无法查看当前会话的子代理、Bash 命令等后台任务的状态和输出
3. **超时机制不合理**：55 秒超时太短，用户可能还在思考就被自动拒绝

### 1.2 目标

1. **后台任务监控**：实时监控子代理、Bash 命令的执行状态和输出
2. **HITL 权限恢复**：页面重载后能恢复权限请求，避免工作流中断
3. **故障恢复机制**：WebSocket 断开、服务器重启等场景的优雅降级
4. **输入队列（可选）**：当 Claude 处于思考状态时，允许用户排队输入

### 1.3 非目标

- ❌ 持久化到数据库（接受服务器重启丢失状态）
- ❌ 跨标签页状态同步
- ❌ AskUserQuestion 回答进度保存（太复杂）
- ❌ 完整的任务调度系统

---

## 2. 核心设计决策

### 2.1 超时机制

- **8 小时超时**：替代原来的 55 秒，覆盖大多数场景
- **前端 10 分钟超时保护**：防止前端永久 hang 死

### 2.2 状态管理

- **以会话为基本单位**：所有任务归属于 sessionId
- **不持久化**：接受服务器重启丢失状态，提示用户
- **localStorage 保存基本信息**：权限请求的基本信息（不含进度）

### 2.3 故障恢复

- **服务器重启检测**：通过 serverId 检测服务器重启
- **WebSocket 断开重置状态**：避免状态不一致
- **全局心跳检测**：30 秒一次，检测服务器存活

### 2.4 输出监控

- **混合方案**：
  - 当前会话的子代理：实时监控（SDK 消息流）
  - 后台任务：5 秒轮询 TaskOutput
- **智能截断**：
  - 移动端：默认 50 行，最大 200 行
  - 桌面端：默认 200 行，最大 1000 行
  - 提供完整日志下载

---

## 3. 架构设计

### 3.1 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      前端 (React)                            │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  WebSocketContext                                    │   │
│  │  - 服务器重启检测 (serverId)                        │   │
│  │  - 断开重置状态                                      │   │
│  │  - 全局心跳 (30s)                                    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  useChatComposerState                                │   │
│  │  - pendingMessage (单条消息暂存)                    │   │
│  │  - 自动发送逻辑                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  useChatRealtimeHandlers                             │   │
│  │  - pendingPermissionRequests (localStorage)          │   │
│  │  - 权限恢复逻辑                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  BackgroundTasksPopover                              │   │
│  │  - 显示子代理、Bash 任务                            │   │
│  │  - 轮询任务输出 (5s)                                 │   │
│  │  - 输出截断显示                                      │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                              ↕ WebSocket
┌─────────────────────────────────────────────────────────────┐
│                      后端 (Node.js)                          │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  server/index.js                                     │   │
│  │  - SERVER_ID (启动时生成)                           │   │
│  │  - 心跳处理 (ping/pong)                             │   │
│  │  - get-pending-permissions                           │   │
│  │  - query-task-output                                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌─────────────────────────────────────────────────────┐   │
│  │  server/claude-sdk.js                                │   │
│  │  - 8 小时超时                                        │   │
│  │  - 跟踪 run_in_background 任务                       │   │
│  │  - 跟踪 Bash 工具调用                                │   │
│  │  - pendingToolApprovals (内存)                       │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                              ↕
┌─────────────────────────────────────────────────────────────┐
│              Claude Agent SDK                                │
│              - Task 工具 (子代理)                            │
│              - Bash 工具                                     │
│              - TaskOutput 工具                               │
│              - AskUserQuestion 工具                          │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 数据流

#### 3.2.1 权限请求恢复流程

```
1. 用户操作触发权限请求
   ↓
2. 后端发送 claude-permission-request
   ↓
3. 前端保存到 pendingPermissionRequests + localStorage
   ↓
4. 显示权限请求 UI
   ↓
5. [页面重载]
   ↓
6. 前端从 localStorage 恢复
   ↓
7. WebSocket 重连后，发送 get-pending-permissions
   ↓
8. 后端查询 pendingToolApprovals，返回待处理请求
   ↓
9. 前端对比本地和服务器状态
   - 如果服务器有 → 恢复 UI
   - 如果服务器没有 → 提示"请求已失效"
```

#### 3.2.2 后台任务监控流程

```
1. Claude 调用 Task/Bash 工具 (run_in_background=true)
   ↓
2. 后端检测到 run_in_background 参数
   ↓
3. 存储任务信息到 backgroundTasks Map
   ↓
4. 发送 background-task-started 到前端
   ↓
5. 前端显示在 BackgroundTasksPopover
   ↓
6. 前端每 5 秒轮询 query-task-output
   ↓
7. 后端调用 TaskOutput 工具，截断输出
   ↓
8. 返回截断的输出到前端
   ↓
9. 前端更新任务输出显示
```

#### 3.2.3 服务器重启检测流程

```
1. 后端启动时生成 SERVER_ID (UUID)
   ↓
2. WebSocket 连接时发送 server-info { serverId }
   ↓
3. 前端保存 serverId
   ↓
4. [服务器重启]
   ↓
5. 前端 WebSocket 断开，3 秒后重连
   ↓
6. 后端发送新的 server-info { serverId: NEW_ID }
   ↓
7. 前端检测到 serverId 变化
   ↓
8. 显示警告："服务器已重启，状态已重置"
   ↓
9. 重置所有本地状态
```

---

## 4. 详细设计

### 4.1 后端改动

#### 4.1.1 超时机制 (`server/claude-sdk.js`)

```javascript
// 修改超时时间
const TOOL_APPROVAL_TIMEOUT_MS = 8 * 60 * 60 * 1000; // 8 小时
```

#### 4.1.2 服务器 ID (`server/index.js`)

```javascript
const SERVER_ID = crypto.randomUUID();

// WebSocket 连接时发送
ws.on('connection', (socket) => {
  socket.send(JSON.stringify({
    type: 'server-info',
    serverId: SERVER_ID,
    version: packageJson.version,
  }));
});
```

#### 4.1.3 权限恢复 (`server/index.js`)

```javascript
case 'get-pending-permissions':
  const sessionId = data.sessionId;
  const pending = [];

  for (const [requestId, approval] of pendingToolApprovals.entries()) {
    if (approval.sessionId === sessionId) {
      pending.push({
        requestId,
        toolName: approval.toolName,
        input: approval.input,
        context: approval.context,
        sessionId: approval.sessionId,
        createdAt: approval.createdAt,
      });
    }
  }

  ws.send(JSON.stringify({
    type: 'pending-permissions',
    sessionId,
    data: pending
  }));
  break;
```

#### 4.1.4 后台任务跟踪 (`server/claude-sdk.js`)

```javascript
const backgroundTasks = new Map(); // task_id -> task info

// 在处理 SDK 消息时
if (message.type === 'tool_use') {
  const { tool_name, input, id } = message;

  // 检测后台任务
  if (input?.run_in_background) {
    backgroundTasks.set(id, {
      taskId: id,
      toolName: tool_name,
      input,
      sessionId: capturedSessionId,
      startTime: Date.now(),
      status: 'running',
    });

    ws.send({
      type: 'background-task-started',
      sessionId: capturedSessionId,
      task: backgroundTasks.get(id),
    });
  }

  // 跟踪所有 Bash 命令
  if (tool_name === 'Bash') {
    ws.send({
      type: 'bash-started',
      sessionId: capturedSessionId,
      bash: {
        id,
        command: input.command,
        description: input.description,
        run_in_background: input.run_in_background || false,
        startTime: Date.now(),
      },
    });
  }
}

// 任务完成时
if (message.type === 'tool_result') {
  const task = backgroundTasks.get(message.tool_use_id);
  if (task) {
    task.status = 'completed';
    task.endTime = Date.now();

    ws.send({
      type: 'background-task-completed',
      sessionId: task.sessionId,
      taskId: message.tool_use_id,
    });
  }
}
```

#### 4.1.5 任务输出查询 (`server/index.js`)

```javascript
case 'query-task-output':
  const taskId = data.taskId;
  const maxLines = data.maxLines || 200;

  // 调用 TaskOutput 工具（需要通过 SDK）
  // 这里需要实现一个辅助函数来调用 SDK 工具
  const output = await queryTaskOutputViaSdk(taskId, sessionId);

  // 截断输出
  const truncated = truncateOutput(output, maxLines);

  ws.send(JSON.stringify({
    type: 'task-output',
    taskId,
    output: truncated,
  }));
  break;

// 截断函数
function truncateOutput(output, maxLines) {
  const lines = output.split('\n');

  if (lines.length <= maxLines) {
    return {
      content: output,
      truncated: false,
      totalLines: lines.length,
    };
  }

  const truncatedLines = lines.slice(-maxLines);
  return {
    content: truncatedLines.join('\n'),
    truncated: true,
    totalLines: lines.length,
    skippedLines: lines.length - maxLines,
  };
}
```

#### 4.1.6 心跳处理 (`server/index.js`)

```javascript
case 'ping':
  ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
  break;
```

### 4.2 前端改动

#### 4.2.1 WebSocket 上下文 (`src/contexts/WebSocketContext.tsx`)

```typescript
const [serverId, setServerId] = useState<string | null>(null);
const [serverAlive, setServerAlive] = useState(true);

// 服务器重启检测
useEffect(() => {
  if (latestMessage?.type === 'server-info') {
    const newServerId = latestMessage.serverId;

    if (serverId && serverId !== newServerId) {
      // 服务器重启了
      showWarning("服务器已重启，状态已重置");
      resetAllState();
    }

    setServerId(newServerId);
  }
}, [latestMessage]);

// WebSocket 断开重置状态
useEffect(() => {
  if (!isConnected) {
    setIsLoading(false);
    setPendingPermissionRequests([]);
    setPendingMessage(null);
  }
}, [isConnected]);

// 全局心跳
useEffect(() => {
  if (!isConnected) return;

  const interval = setInterval(() => {
    sendMessage({ type: 'ping' });

    const timeout = setTimeout(() => {
      setServerAlive(false);
      showError("服务器无响应");
    }, 5000);

    // 收到 pong 后清除 timeout
    const unsubscribe = subscribeToMessage('pong', () => {
      clearTimeout(timeout);
      setServerAlive(true);
    });

    return () => {
      clearTimeout(timeout);
      unsubscribe();
    };
  }, 30000);

  return () => clearInterval(interval);
}, [isConnected]);
```

#### 4.2.2 权限恢复 (`src/components/chat/hooks/useChatRealtimeHandlers.ts`)

```typescript
// 保存到 localStorage
useEffect(() => {
  if (pendingPermissionRequests.length > 0) {
    localStorage.setItem(
      `pending-permissions-${currentSessionId}`,
      JSON.stringify(pendingPermissionRequests)
    );
  } else {
    localStorage.removeItem(`pending-permissions-${currentSessionId}`);
  }
}, [pendingPermissionRequests, currentSessionId]);

// 页面加载时恢复
useEffect(() => {
  const saved = localStorage.getItem(`pending-permissions-${currentSessionId}`);
  if (saved) {
    setPendingPermissionRequests(JSON.parse(saved));
  }
}, [currentSessionId]);

// WebSocket 重连后查询
useEffect(() => {
  if (isConnected && currentSessionId) {
    sendMessage({
      type: 'get-pending-permissions',
      sessionId: currentSessionId
    });
  }
}, [isConnected, currentSessionId]);

// 接收服务器状态
useEffect(() => {
  if (latestMessage?.type === 'pending-permissions') {
    const serverRequests = latestMessage.data;
    const localRequests = pendingPermissionRequests;

    if (localRequests.length > 0 && serverRequests.length === 0) {
      showWarning("部分权限请求已失效");
      setPendingPermissionRequests([]);
    } else if (serverRequests.length > 0) {
      setPendingPermissionRequests(serverRequests);
    }
  }
}, [latestMessage]);
```

#### 4.2.3 输入队列 (`src/components/chat/hooks/useChatComposerState.ts`)

```typescript
const [pendingMessage, setPendingMessage] = useState<string | null>(null);

// 发送消息时
const handleSendMessage = (message: string) => {
  if (isLoading) {
    // 只保存最后一条
    setPendingMessage(message);
    showInfo("消息已排队，等待当前任务完成");
  } else {
    sendMessageToBackend(message);
  }
};

// isLoading 变化时自动发送
useEffect(() => {
  if (!isLoading && pendingMessage) {
    sendMessageToBackend(pendingMessage);
    setPendingMessage(null);
  }
}, [isLoading, pendingMessage]);
```

#### 4.2.4 前端超时保护 (`src/components/chat/hooks/useChatSessionState.ts`)

```typescript
// 10 分钟超时保护
useEffect(() => {
  if (!isLoading) return;

  const timeout = setTimeout(() => {
    setIsLoading(false);
    showError("请求超时，已自动重置");
  }, 10 * 60 * 1000);

  return () => clearTimeout(timeout);
}, [isLoading]);
```

#### 4.2.5 后台任务监控 (`src/components/app/BackgroundTasksPopover.tsx`)

```typescript
export const BackgroundTasksPopover = () => {
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [taskOutputs, setTaskOutputs] = useState<Map<string, TaskOutput>>(new Map());
  const { sendMessage, latestMessage } = useWebSocket();
  const { currentSessionId } = useChatSession();
  const isMobile = useIsMobile();

  // 监听任务启动
  useEffect(() => {
    if (latestMessage?.type === 'background-task-started') {
      setTasks(prev => [...prev, latestMessage.task]);
    }
    if (latestMessage?.type === 'bash-started') {
      setTasks(prev => [...prev, latestMessage.bash]);
    }
  }, [latestMessage]);

  // 轮询任务输出
  useEffect(() => {
    const interval = setInterval(() => {
      tasks.forEach(task => {
        if (task.status === 'running') {
          sendMessage({
            type: 'query-task-output',
            taskId: task.taskId,
            maxLines: isMobile ? 50 : 200,
          });
        }
      });
    }, 5000);

    return () => clearInterval(interval);
  }, [tasks, isMobile]);

  // 接收输出更新
  useEffect(() => {
    if (latestMessage?.type === 'task-output') {
      setTaskOutputs(prev => {
        const next = new Map(prev);
        next.set(latestMessage.taskId, latestMessage.output);
        return next;
      });
    }
  }, [latestMessage]);

  const runningTasks = tasks.filter(t => t.status === 'running');

  return (
    <Popover.Root>
      <Popover.Trigger>
        <button className="relative">
          <ListTodo size={20} />
          {runningTasks.length > 0 && (
            <span className="absolute -top-1 -right-1 bg-blue-500 text-white text-xs rounded-full w-4 h-4">
              {runningTasks.length}
            </span>
          )}
        </button>
      </Popover.Trigger>
      <Popover.Content className="w-96 max-h-[600px] overflow-y-auto">
        <Tabs defaultValue="subagents">
          <TabsList>
            <TabsTrigger value="subagents">子代理</TabsTrigger>
            <TabsTrigger value="bash">Bash</TabsTrigger>
          </TabsList>

          <TabsContent value="subagents">
            {tasks.filter(t => t.toolName === 'Task').map(task => (
              <TaskItem
                key={task.taskId}
                task={task}
                output={taskOutputs.get(task.taskId)}
              />
            ))}
          </TabsContent>

          <TabsContent value="bash">
            {tasks.filter(t => t.toolName === 'Bash').map(task => (
              <BashItem
                key={task.taskId}
                task={task}
                output={taskOutputs.get(task.taskId)}
              />
            ))}
          </TabsContent>
        </Tabs>
      </Popover.Content>
    </Popover.Root>
  );
};
```

---

## 5. 实现计划

### 5.1 阶段划分

**阶段 1：核心基础设施（2 天）**
- 后端：8 小时超时、服务器 ID、心跳处理
- 前端：WebSocket 上下文改造、服务器重启检测

**阶段 2：权限恢复（2 天）**
- 后端：get-pending-permissions 处理
- 前端：localStorage 保存/恢复、状态同步逻辑

**阶段 3：后台任务监控（2-3 天）**
- 后端：任务跟踪、输出查询、截断逻辑
- 前端：BackgroundTasksPopover 组件、轮询逻辑

**阶段 4：输入队列（可选，1 天）**
- 前端：pendingMessage 逻辑、自动发送

**阶段 5：测试与优化（1 天）**
- 集成测试、性能优化、边界情况处理

### 5.2 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| TaskOutput 调用复杂 | 高 | 先实现简单版本，验证可行性 |
| 输出截断逻辑错误 | 中 | 充分测试各种输出大小 |
| 内存泄漏 | 中 | 定期清理完成的任务 |
| 并发问题 | 低 | 使用 Map 而非数组，避免竞态 |

---

## 6. 测试策略

### 6.1 单元测试

- 输出截断函数
- serverId 检测逻辑
- localStorage 保存/恢复

### 6.2 集成测试

- 权限请求恢复流程
- 后台任务监控流程
- 服务器重启场景

### 6.3 性能测试

- 50 万行输出截断性能
- 轮询对服务器的影响
- 内存使用情况

---

## 7. 未来优化

### 7.1 短期优化（1-2 周内）

- 添加任务搜索/过滤功能
- 支持任务取消操作
- 优化轮询频率（根据任务类型调整）

### 7.2 长期优化（1-2 月内）

- 持久化到数据库（可选）
- 跨标签页状态同步
- 任务执行历史记录
- 任务性能分析

---

## 8. 附录

### 8.1 相关文件清单

**后端：**
- `server/claude-sdk.js` - SDK 集成、任务跟踪
- `server/index.js` - WebSocket 处理、API 路由

**前端：**
- `src/contexts/WebSocketContext.tsx` - WebSocket 管理
- `src/components/chat/hooks/useChatRealtimeHandlers.ts` - 权限恢复
- `src/components/chat/hooks/useChatComposerState.ts` - 输入队列
- `src/components/app/BackgroundTasksPopover.tsx` - 任务监控 UI

### 8.2 参考资料

- Claude Agent SDK 文档
- WebSocket API 文档
- React Context 最佳实践
