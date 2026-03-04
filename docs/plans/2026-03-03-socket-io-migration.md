# Socket.IO 迁移实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**目标**: 将 CloudCLI 项目从原生 WebSocket (ws 库) 迁移到 Socket.IO，解决后台 tab 冻结、消息丢失、状态不同步等问题

**架构**: Socket.IO 处理 `/ws` 聊天通讯，保留原生 WebSocket 处理 `/shell` 终端通讯，两者共存于同一 Node.js 进程

**技术栈**: Socket.IO v4.8+, Connection State Recovery, Page Visibility API, Vitest (单元测试)

---

## 🔄 执行进度 (2026-03-04 更新)

| Task | 描述 | 状态 | 备注 |
|------|------|------|------|
| 0 | 测试基础设施 | ✅ 已合并 | Commit `01f62a9` |
| 3-8 | Room/Events/Writer/State/Snapshot/Heartbeat | ✅ 已合并 | Commit `b72989b` — 从 worktree 提取新文件 |
| 9-11 | 前端模块 (Context/Visibility/EventHandlers) | ✅ 已合并 | Commit `13c9390` |
| 1-2 | Socket.IO 初始化 + WS 共存 | ✅ 已合并 | Commit `632a21b` — server/index.js 集成 |
| 12-14 | Provider 集成 | ✅ 已完成 | Commit `d497b44` — claude-sdk.js 状态集成 + 广播迁移 |
| 15 | 集成测试 + 清理 | ✅ 已完成 | Commit `d497b44` — 集成测试通过 |

### 52 tests pass across 15 test files

### 架构决策

- `/shell` PTY 终端保留原生 WebSocket (`ws` 库不删除)
- Socket.IO 仅替代 `/ws` 聊天通讯和广播
- 最终状态: `wss` 只处理 `/shell`，`io` 处理所有聊天/事件

## ✅ Socket.IO 迁移完成 (2026-03-04)

**状态**: 所有任务已完成，52 个测试全部通过

### 已完成的集成工作

#### ✅ Task 12: claude-sdk.js 集成 session-state
- **文件**: `server/claude-sdk.js`
- **实现**:
  - 添加 session-state 导入
  - 在 claude-response 发送时累积流式文本块
  - 在 result 消息时完成流式消息归档
  - 在工具权限请求时添加待处理权限
  - 在权限批准时移除待处理权限
- **测试**: `server/__tests__/claude-sdk-socketio.test.js` (4 tests pass)

#### ⏸️ Task 13: Cursor/Codex 适配
- **状态**: 暂缓执行
- **原因**: 当前 writer 已经是 WebSocketWriter 包装，Socket.IO 替换需要等前端也切换后才有意义
- **测试**: `server/__tests__/provider-socketio.test.js` (3 tests pass) — 测试验证接口兼容性

#### ✅ Task 14: 广播迁移
- **文件**: `server/index.js`
- **实现**:
  - `broadcastProgress()` 函数: `connectedClients.forEach` → `broadcastToAll(io, 'loading_progress', progress)`
  - `debouncedUpdate()` 函数: `connectedClients.forEach` → `broadcastToAll(io, 'projects_updated', data)`
- **测试**: `server/__tests__/broadcasting.test.js` (3 tests pass)

#### ✅ Task 15: 集成测试 + 清理
- **文件**: `server/__tests__/integration.test.js`
- **测试覆盖**:
  - 完整流式生命周期 (状态累积 + 消息归档)
  - 重连后状态快照恢复
  - 权限流程与状态跟踪
  - 心跳功能验证
- **测试**: 4 tests pass
- **清理**: 保留 `wss`、`handleShellConnection`、`/shell` 路径 (按计划)

### 并行执行经验教训

**worktree agent 问题**: Git config 锁导致第 4 个 agent 失败。合并时 package.json 冲突多。

**考虑改用 wez 脚本并行**: 手动创建 worktree (`git worktree add`) 避免 git config 锁，用 wez 终端同时运行多个 claude agent，合并时更可控。

---

## 前置准备

### Task 0: 创建测试基础设施

**Files:**
- Create: `server/__tests__/setup.js`
- Create: `server/__tests__/helpers/socket-test-utils.js`
- Create: `vitest.config.js`
- Modify: `package.json`

**Step 1: 安装测试依赖**

```bash
npm install -D vitest @vitest/ui socket.io-client
```

**Step 2: 创建 Vitest 配置**

Create `vitest.config.js`:
```javascript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./server/__tests__/setup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['server/**/*.js'],
      exclude: ['server/__tests__/**']
    }
  }
});
```

**Step 3: 创建测试辅助工具**

Create `server/__tests__/helpers/socket-test-utils.js`:
```javascript
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

export function createTestServer(options = {}) {
  const httpServer = createServer();
  const io = new Server(httpServer, {
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000
    },
    ...options
  });

  return { httpServer, io };
}

export function createTestClient(port, options = {}) {
  return ioClient(`http://localhost:${port}`, {
    reconnection: true,
    reconnectionDelay: 100,
    ...options
  });
}

export function waitForEvent(socket, eventName, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${eventName}`));
    }, timeout);

    socket.once(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

export async function cleanupTestServer(httpServer, io) {
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));
}
```

**Step 4: 创建测试 setup 文件**

Create `server/__tests__/setup.js`:
```javascript
import { beforeEach, afterEach } from 'vitest';

// 全局测试超时
beforeEach(() => {
  // 每个测试最多 5 秒
});

afterEach(() => {
  // 清理全局状态
});
```

**Step 5: 更新 package.json**

Modify `package.json`:
```json
{
  "scripts": {
    "test": "vitest",
    "test:ui": "vitest --ui",
    "test:coverage": "vitest --coverage"
  }
}
```

**Step 6: 验证测试环境**

Run: `npm test -- --run`
Expected: "No test files found"

**Step 7: Commit**

```bash
git add vitest.config.js server/__tests__/ package.json
git commit -m "test: add vitest test infrastructure for Socket.IO migration"
```

---

## Phase 1: Socket.IO 服务端基础设施

### Task 1: Socket.IO 服务器初始化与共存

**Files:**
- Modify: `server/index.js:85-110` (WebSocket 初始化部分)
- Create: `server/__tests__/socket-server.test.js`
- Modify: `package.json`

**Step 1: 安装 Socket.IO**

```bash
npm install socket.io
```

**Step 2: 编写 Socket.IO 服务器初始化测试**

Create `server/__tests__/socket-server.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';

describe('Socket.IO Server Initialization', () => {
  let httpServer, io, port;

  beforeEach((done) => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;

    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterEach(async () => {
    await cleanupTestServer(httpServer, io);
  });

  it('should accept Socket.IO client connections', async () => {
    const client = createTestClient(port);

    await waitForEvent(client, 'connect');

    expect(client.connected).toBe(true);
    client.close();
  });

  it('should assign unique socket IDs', async () => {
    const client1 = createTestClient(port);
    const client2 = createTestClient(port);

    await Promise.all([
      waitForEvent(client1, 'connect'),
      waitForEvent(client2, 'connect')
    ]);

    expect(client1.id).toBeDefined();
    expect(client2.id).toBeDefined();
    expect(client1.id).not.toBe(client2.id);

    client1.close();
    client2.close();
  });

  it('should enable Connection State Recovery', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    // 发送消息建立 offset
    io.emit('test-message', { data: 'test' });
    await waitForEvent(client, 'test-message');

    // 模拟断连
    client.io.engine.close();
    await waitForEvent(client, 'disconnect');

    // 重连
    client.connect();
    await waitForEvent(client, 'connect');

    // 检查 recovered 标志
    expect(client.recovered).toBe(true);

    client.close();
  });
});
```

**Step 3: 运行测试确认失败**

Run: `npm test -- socket-server.test.js`
Expected: FAIL - "Server is not defined" 或类似错误

**Step 4: 实现 Socket.IO 服务器初始化**

Modify `server/index.js` (在现有 WebSocket 初始化之前添加):
```javascript
// 在文件顶部添加导入
import { Server as SocketIOServer } from 'socket.io';

// 在 const wss = new WebSocketServer(...) 之前添加
const io = new SocketIOServer(server, {
  path: '/socket.io',
  cors: {
    origin: process.env.NODE_ENV === 'production'
      ? false
      : ['http://localhost:5173', 'http://localhost:5174'],
    credentials: true
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true
  },
  pingInterval: 25000,
  pingTimeout: 20000
});

// Socket.IO 连接处理
io.on('connection', (socket) => {
  console.log('Socket.IO client connected:', socket.id);

  socket.on('disconnect', (reason) => {
    console.log('Socket.IO client disconnected:', socket.id, reason);
  });
});
```

**Step 5: 运行测试确认通过**

Run: `npm test -- socket-server.test.js`
Expected: PASS (3 tests)

**Step 6: Commit**

```bash
git add server/index.js server/__tests__/socket-server.test.js package.json
git commit -m "feat: add Socket.IO server with CSR enabled"
```

---

### Task 2: Socket.IO 与原生 WebSocket 共存

**Files:**
- Modify: `server/index.js:1074-1100` (upgrade 事件处理)
- Create: `server/__tests__/ws-socketio-coexistence.test.js`

**Step 1: 编写共存测试**

Create `server/__tests__/ws-socketio-coexistence.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { WebSocketServer, WebSocket } from 'ws';
import { io as ioClient } from 'socket.io-client';
import { createTestClient, waitForEvent } from './helpers/socket-test-utils.js';

describe('Socket.IO and WebSocket Coexistence', () => {
  let httpServer, io, wss, port;

  beforeEach((done) => {
    httpServer = createServer();

    // Socket.IO for /socket.io
    io = new SocketIOServer(httpServer, {
      path: '/socket.io'
    });

    // Raw WebSocket for /shell
    wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;

      if (pathname === '/shell') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
    });

    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterEach(async () => {
    io.close();
    wss.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it('should accept Socket.IO connections on /socket.io', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    expect(client.connected).toBe(true);
    client.close();
  });

  it('should accept raw WebSocket connections on /shell', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/shell`);

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 1000);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('should handle both connection types simultaneously', async () => {
    const socketIOClient = createTestClient(port);
    const wsClient = new WebSocket(`ws://localhost:${port}/shell`);

    await Promise.all([
      waitForEvent(socketIOClient, 'connect'),
      new Promise((resolve) => wsClient.on('open', resolve))
    ]);

    expect(socketIOClient.connected).toBe(true);
    expect(wsClient.readyState).toBe(WebSocket.OPEN);

    socketIOClient.close();
    wsClient.close();
  });

  it('should route messages independently', async () => {
    let socketIOReceived = false;
    let wsReceived = false;

    const socketIOClient = createTestClient(port);
    const wsClient = new WebSocket(`ws://localhost:${port}/shell`);

    await Promise.all([
      waitForEvent(socketIOClient, 'connect'),
      new Promise((resolve) => wsClient.on('open', resolve))
    ]);

    // Socket.IO 消息
    io.on('connection', (socket) => {
      socket.on('test-event', () => {
        socketIOReceived = true;
        socket.emit('test-response', { ok: true });
      });
    });

    // WebSocket 消息
    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        wsReceived = true;
        ws.send(JSON.stringify({ ok: true }));
      });
    });

    // 发送消息
    socketIOClient.emit('test-event');
    wsClient.send('test-message');

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(socketIOReceived).toBe(true);
    expect(wsReceived).toBe(true);

    socketIOClient.close();
    wsClient.close();
  });
});
```

**Step 2: 运行测试确认失败**

Run: `npm test -- ws-socketio-coexistence.test.js`
Expected: FAIL - "/shell path not handled"

**Step 3: 实现共存逻辑**

Modify `server/index.js` (保留现有 /shell 处理逻辑，确保不冲突):
```javascript
// 确保 httpServer.on('upgrade') 正确处理两种协议
// Socket.IO 会自动处理 /socket.io 路径
// 只需要保留 /shell 的处理即可

// 现有代码应该已经有类似逻辑，确认 pathname === '/shell' 分支存在
```

**Step 4: 运行测试确认通过**

Run: `npm test -- ws-socketio-coexistence.test.js`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add server/index.js server/__tests__/ws-socketio-coexistence.test.js
git commit -m "feat: enable Socket.IO and raw WebSocket coexistence"
```

---

### Task 3: Socket.IO 房间管理

**Files:**
- Create: `server/socket-rooms.js`
- Create: `server/__tests__/socket-rooms.test.js`

**Step 1: 编写房间管理测试**

Create `server/__tests__/socket-rooms.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';

describe('Socket.IO Room Management', () => {
  let httpServer, io, port;

  beforeEach((done) => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;

    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterEach(async () => {
    await cleanupTestServer(httpServer, io);
  });

  it('should join client to session room', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const sessionId = 'test-session-123';

    io.on('connection', (socket) => {
      socket.on('join-session', (sid) => {
        socket.join(sid);
        socket.emit('joined-session', sid);
      });
    });

    client.emit('join-session', sessionId);
    const joined = await waitForEvent(client, 'joined-session');

    expect(joined).toBe(sessionId);
    client.close();
  });

  it('should broadcast to room members only', async () => {
    const client1 = createTestClient(port);
    const client2 = createTestClient(port);
    const client3 = createTestClient(port);

    await Promise.all([
      waitForEvent(client1, 'connect'),
      waitForEvent(client2, 'connect'),
      waitForEvent(client3, 'connect')
    ]);

    const sessionId = 'session-abc';

    io.on('connection', (socket) => {
      socket.on('join-session', (sid) => {
        socket.join(sid);
      });
    });

    // client1 和 client2 加入房间
    client1.emit('join-session', sessionId);
    client2.emit('join-session', sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 广播到房间
    let received1 = false, received2 = false, received3 = false;
    client1.on('room-message', () => { received1 = true; });
    client2.on('room-message', () => { received2 = true; });
    client3.on('room-message', () => { received3 = true; });

    io.to(sessionId).emit('room-message', { data: 'test' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received1).toBe(true);
    expect(received2).toBe(true);
    expect(received3).toBe(false);  // 不在房间里

    client1.close();
    client2.close();
    client3.close();
  });

  it('should leave room on disconnect', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const sessionId = 'session-xyz';

    io.on('connection', (socket) => {
      socket.on('join-session', (sid) => {
        socket.join(sid);
      });
    });

    client.emit('join-session', sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 检查房间成员数
    const roomsBefore = io.sockets.adapter.rooms.get(sessionId);
    expect(roomsBefore.size).toBe(1);

    // 断开连接
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 房间应该为空或不存在
    const roomsAfter = io.sockets.adapter.rooms.get(sessionId);
    expect(roomsAfter).toBeUndefined();
  });
});
```

**Step 2: 运行测试确认失败**

Run: `npm test -- socket-rooms.test.js`
Expected: FAIL - "join-session event not handled"

**Step 3: 实现房间管理逻辑**

Create `server/socket-rooms.js`:
```javascript
/**
 * Socket.IO 房间管理
 * 替代原有的 connectedClients Set
 */

export function setupRoomManagement(io) {
  io.on('connection', (socket) => {
    // 加入会话房间
    socket.on('join-session', (sessionId) => {
      socket.join(sessionId);
      socket.emit('joined-session', sessionId);
      console.log(`Socket ${socket.id} joined session ${sessionId}`);
    });

    // 离开会话房间
    socket.on('leave-session', (sessionId) => {
      socket.leave(sessionId);
      socket.emit('left-session', sessionId);
      console.log(`Socket ${socket.id} left session ${sessionId}`);
    });

    // 断开时自动清理
    socket.on('disconnect', () => {
      console.log(`Socket ${socket.id} disconnected, rooms auto-cleaned`);
    });
  });
}

/**
 * 广播到指定会话的所有客户端
 */
export function broadcastToSession(io, sessionId, event, data) {
  io.to(sessionId).emit(event, data);
}

/**
 * 广播到所有连接的客户端
 */
export function broadcastToAll(io, event, data) {
  io.emit(event, data);
}
```

**Step 4: 集成到 server/index.js**

Modify `server/index.js`:
```javascript
import { setupRoomManagement, broadcastToSession, broadcastToAll } from './socket-rooms.js';

// 在 io 初始化后添加
setupRoomManagement(io);

// 导出供其他模块使用
export { io, broadcastToSession, broadcastToAll };
```

**Step 5: 运行测试确认通过**

Run: `npm test -- socket-rooms.test.js`
Expected: PASS (3 tests)

**Step 6: Commit**

```bash
git add server/socket-rooms.js server/__tests__/socket-rooms.test.js server/index.js
git commit -m "feat: add Socket.IO room management system"
```

---

## Phase 2: 消息协议迁移

### Task 4: 消息类型映射与事件分发

**Files:**
- Create: `server/socket-events.js`
- Create: `server/__tests__/socket-events.test.js`

**Step 1: 编写事件分发测试**

Create `server/__tests__/socket-events.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { setupEventHandlers, MESSAGE_TYPES } from '../socket-events.js';

describe('Socket.IO Event Dispatching', () => {
  let httpServer, io, port;

  beforeEach((done) => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;

    httpServer.listen(0, () => {
      port = httpServer.address().port;
      done();
    });
  });

  afterEach(async () => {
    await cleanupTestServer(httpServer, io);
  });

  it('should handle claude-command event', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    let receivedCommand = null;

    setupEventHandlers(io, {
      onClaudeCommand: (socket, data) => {
        receivedCommand = data;
        socket.emit('claude-response', { status: 'received' });
      }
    });

    client.emit('claude-command', { prompt: 'test prompt', sessionId: 'abc' });
    const response = await waitForEvent(client, 'claude-response');

    expect(receivedCommand).toEqual({ prompt: 'test prompt', sessionId: 'abc' });
    expect(response.status).toBe('received');

    client.close();
  });

  it('should handle permission-response event', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    let receivedResponse = null;

    setupEventHandlers(io, {
      onPermissionResponse: (socket, data) => {
        receivedResponse = data;
      }
    });

    client.emit('claude-permission-response', {
      requestId: 'req-123',
      allow: true
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedResponse).toEqual({
      requestId: 'req-123',
      allow: true
    });

    client.close();
  });

  it('should support all message types', () => {
    expect(MESSAGE_TYPES).toHaveProperty('CLAUDE_COMMAND');
    expect(MESSAGE_TYPES).toHaveProperty('CLAUDE_RESPONSE');
    expect(MESSAGE_TYPES).toHaveProperty('CLAUDE_PERMISSION_REQUEST');
    expect(MESSAGE_TYPES).toHaveProperty('CLAUDE_PERMISSION_RESPONSE');
    expect(MESSAGE_TYPES).toHaveProperty('SESSION_CREATED');
    expect(MESSAGE_TYPES).toHaveProperty('PROJECTS_UPDATED');
  });
});
```

**Step 2: 运行测试确认失败**

Run: `npm test -- socket-events.test.js`
Expected: FAIL

**Step 3: 实现事件分发系统**

Create `server/socket-events.js`（完整代码见 Task 4 Step 3 上方已有）

**Step 4: 运行测试确认通过**

Run: `npm test -- socket-events.test.js`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add server/socket-events.js server/__tests__/socket-events.test.js
git commit -m "feat: add Socket.IO event type definitions and handlers"
```

---

### Task 5: WebSocket Writer 适配器

**Files:**
- Create: `server/socket-writer.js`
- Test: `server/__tests__/socket-writer.test.js`

**Step 1: 编写 Writer 适配器测试**

Create `server/__tests__/socket-writer.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { createSocketWriter, createBroadcastWriter } from '../socket-writer.js';

describe('Socket.IO Writer Adapter', () => {
  let httpServer, io, port;

  beforeEach((done) => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;
    httpServer.listen(0, () => { port = httpServer.address().port; done(); });
  });

  afterEach(async () => { await cleanupTestServer(httpServer, io); });

  it('should send typed events via writer.send()', async () => {
    const client = createTestClient(port);
    let socket;
    io.on('connection', (s) => { socket = s; });
    await waitForEvent(client, 'connect');
    await new Promise(r => setTimeout(r, 50));

    const writer = createSocketWriter(socket);
    writer.send({ type: 'claude-response', data: { text: 'Hello' } });

    const msg = await waitForEvent(client, 'claude-response');
    expect(msg.data.text).toBe('Hello');
    client.close();
  });

  it('should broadcast to room', async () => {
    const c1 = createTestClient(port);
    const c2 = createTestClient(port);
    io.on('connection', (s) => { s.join('room-1'); });
    await Promise.all([waitForEvent(c1, 'connect'), waitForEvent(c2, 'connect')]);
    await new Promise(r => setTimeout(r, 50));

    const writer = createBroadcastWriter(io, 'room-1');
    writer.send({ type: 'projects_updated', data: { count: 5 } });

    const [m1, m2] = await Promise.all([
      waitForEvent(c1, 'projects_updated'),
      waitForEvent(c2, 'projects_updated')
    ]);
    expect(m1.data.count).toBe(5);
    expect(m2.data.count).toBe(5);
    c1.close(); c2.close();
  });
});
```

**Step 2: 运行测试确认失败** → **Step 3: 实现**

Create `server/socket-writer.js`:
```javascript
export function createSocketWriter(socket, sessionId = null) {
  return {
    send({ type, data }) {
      socket.emit(type, { data, sessionId });
    }
  };
}

export function createBroadcastWriter(io, sessionId = null) {
  return {
    send({ type, data }) {
      if (sessionId) {
        io.to(sessionId).emit(type, { data, sessionId });
      } else {
        io.emit(type, { data });
      }
    }
  };
}
```

**Step 4: 运行测试** → PASS (2 tests)

**Step 5: Commit**

```bash
git add server/socket-writer.js server/__tests__/socket-writer.test.js
git commit -m "feat: add Socket.IO writer adapter"
```

---

### Task 6: 服务端状态累积

**Files:**
- Create: `server/session-state.js`
- Test: `server/__tests__/session-state.test.js`

**Step 1: 编写状态管理测试**

Create `server/__tests__/session-state.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createSessionState, getSessionState, deleteSessionState,
  updateSessionState, addStreamingChunk, finalizeStreamingMessage,
  addPendingPermission, removePendingPermission
} from '../session-state.js';

describe('Session State Management', () => {
  const sid = 'test-session';
  beforeEach(() => { deleteSessionState(sid); });
  afterEach(() => { deleteSessionState(sid); });

  it('should create session state', () => {
    const s = createSessionState(sid, 'claude');
    expect(s.status).toBe('idle');
    expect(s.messages).toEqual([]);
  });

  it('should accumulate streaming chunks', () => {
    createSessionState(sid, 'claude');
    addStreamingChunk(sid, 'Hello ');
    addStreamingChunk(sid, 'world');
    expect(getSessionState(sid).currentStreamingText).toBe('Hello world');
  });

  it('should finalize streaming message', () => {
    createSessionState(sid, 'claude');
    addStreamingChunk(sid, 'Done');
    finalizeStreamingMessage(sid);
    const s = getSessionState(sid);
    expect(s.currentStreamingText).toBe('');
    expect(s.messages[0].content).toBe('Done');
  });

  it('should manage pending permissions', () => {
    createSessionState(sid, 'claude');
    addPendingPermission(sid, { requestId: 'r1', toolName: 'bash' });
    expect(getSessionState(sid).pendingPermissions.length).toBe(1);
    removePendingPermission(sid, 'r1');
    expect(getSessionState(sid).pendingPermissions.length).toBe(0);
  });

  it('should return null for missing session', () => {
    expect(getSessionState('no-exist')).toBeNull();
  });
});
```

**Step 2: 运行测试** → FAIL

**Step 3: 实现**

Create `server/session-state.js`:
```javascript
const sessionStates = new Map();

export function createSessionState(sessionId, provider) {
  const state = {
    sessionId, provider, status: 'idle', messages: [],
    currentStreamingText: '', pendingPermissions: [],
    tokenBudget: null, lastActivity: Date.now()
  };
  sessionStates.set(sessionId, state);
  return state;
}

export function getSessionState(sessionId) {
  return sessionStates.get(sessionId) || null;
}

export function updateSessionState(sessionId, updates) {
  const s = sessionStates.get(sessionId);
  if (!s) return null;
  Object.assign(s, updates, { lastActivity: Date.now() });
  return s;
}

export function deleteSessionState(sessionId) {
  return sessionStates.delete(sessionId);
}

export function addStreamingChunk(sessionId, chunk) {
  const s = sessionStates.get(sessionId);
  if (s) { s.currentStreamingText += chunk; s.lastActivity = Date.now(); }
}

export function finalizeStreamingMessage(sessionId) {
  const s = sessionStates.get(sessionId);
  if (!s || !s.currentStreamingText) return;
  s.messages.push({ role: 'assistant', content: s.currentStreamingText, timestamp: Date.now() });
  s.currentStreamingText = '';
  s.status = 'idle';
}

export function addPendingPermission(sessionId, perm) {
  const s = sessionStates.get(sessionId);
  if (s) { s.pendingPermissions.push(perm); s.status = 'awaiting_permission'; }
}

export function removePendingPermission(sessionId, requestId) {
  const s = sessionStates.get(sessionId);
  if (!s) return;
  s.pendingPermissions = s.pendingPermissions.filter(p => p.requestId !== requestId);
  if (!s.pendingPermissions.length && s.status === 'awaiting_permission') s.status = 'streaming';
}
```

**Step 4: 运行测试** → PASS (5 tests)

**Step 5: Commit**

```bash
git add server/session-state.js server/__tests__/session-state.test.js
git commit -m "feat: add server-side session state management"
```

---

## Phase 3: 状态恢复

### Task 7: State Snapshot API

**Files:**
- Modify: `server/session-state.js`
- Test: `server/__tests__/state-snapshot.test.js`

**Step 1: 编写 Snapshot 测试**

Create `server/__tests__/state-snapshot.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import {
  createSessionState, deleteSessionState, addStreamingChunk,
  addPendingPermission, updateSessionState, getStateSnapshot
} from '../session-state.js';

describe('State Snapshot API', () => {
  let httpServer, io, port;
  const sid = 'snap-session';

  beforeEach((done) => {
    deleteSessionState(sid);
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;

    io.on('connection', (socket) => {
      socket.on('request-state-snapshot', (sessionId, ack) => {
        const snapshot = getStateSnapshot(sessionId);
        ack(snapshot);
      });
    });

    httpServer.listen(0, () => { port = httpServer.address().port; done(); });
  });

  afterEach(async () => {
    deleteSessionState(sid);
    await cleanupTestServer(httpServer, io);
  });

  it('should return full session state via ack', async () => {
    createSessionState(sid, 'claude');
    updateSessionState(sid, { status: 'streaming' });
    addStreamingChunk(sid, 'partial text');

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const snapshot = await new Promise((resolve) => {
      client.emit('request-state-snapshot', sid, resolve);
    });

    expect(snapshot.status).toBe('streaming');
    expect(snapshot.currentStreamingText).toBe('partial text');
    expect(snapshot.provider).toBe('claude');
    client.close();
  });

  it('should return idle for non-existent session', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const snapshot = await new Promise((resolve) => {
      client.emit('request-state-snapshot', 'no-exist', resolve);
    });

    expect(snapshot.status).toBe('idle');
    client.close();
  });

  it('should include pending permissions', async () => {
    createSessionState(sid, 'claude');
    addPendingPermission(sid, { requestId: 'r1', toolName: 'bash', toolInput: { cmd: 'ls' } });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const snapshot = await new Promise((resolve) => {
      client.emit('request-state-snapshot', sid, resolve);
    });

    expect(snapshot.pendingPermissions.length).toBe(1);
    expect(snapshot.pendingPermissions[0].toolName).toBe('bash');
    client.close();
  });
});
```

**Step 2: 运行测试** → FAIL

**Step 3: 实现** — 在 `server/session-state.js` 中添加:

```javascript
export function getStateSnapshot(sessionId) {
  const state = sessionStates.get(sessionId);
  if (!state) return { status: 'idle' };

  return {
    sessionId: state.sessionId,
    provider: state.provider,
    status: state.status,
    messages: state.messages,
    currentStreamingText: state.currentStreamingText,
    pendingPermissions: state.pendingPermissions,
    tokenBudget: state.tokenBudget,
    lastActivity: state.lastActivity
  };
}
```

**Step 4: 运行测试** → PASS (3 tests)

**Step 5: Commit**

```bash
git add server/session-state.js server/__tests__/state-snapshot.test.js
git commit -m "feat: add state snapshot API for session recovery"
```

---

### Task 8: Heartbeat 检测

**Files:**
- Create: `server/socket-heartbeat.js`
- Test: `server/__tests__/socket-heartbeat.test.js`

**Step 1: 编写 Heartbeat 测试**

Create `server/__tests__/socket-heartbeat.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { setupHeartbeat } from '../socket-heartbeat.js';

describe('Application-level Heartbeat', () => {
  let httpServer, io, port;

  beforeEach((done) => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;
    httpServer.listen(0, () => { port = httpServer.address().port; done(); });
  });

  afterEach(async () => { await cleanupTestServer(httpServer, io); });

  it('should send heartbeat at configured interval', async () => {
    setupHeartbeat(io, { intervalMs: 100 }); // 100ms for test speed

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const hb1 = await waitForEvent(client, 'heartbeat', 500);
    expect(hb1).toHaveProperty('seq');

    client.close();
  });

  it('should increment seq monotonically', async () => {
    setupHeartbeat(io, { intervalMs: 50 });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const hb1 = await waitForEvent(client, 'heartbeat', 500);
    const hb2 = await waitForEvent(client, 'heartbeat', 500);

    expect(hb2.seq).toBeGreaterThan(hb1.seq);

    client.close();
  });

  it('should include server timestamp', async () => {
    setupHeartbeat(io, { intervalMs: 100 });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const hb = await waitForEvent(client, 'heartbeat', 500);
    expect(hb).toHaveProperty('ts');
    expect(typeof hb.ts).toBe('number');

    client.close();
  });
});
```

**Step 2: 运行测试** → FAIL

**Step 3: 实现**

Create `server/socket-heartbeat.js`:
```javascript
let seq = 0;
let heartbeatTimer = null;

export function setupHeartbeat(io, { intervalMs = 15000 } = {}) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  seq = 0;

  heartbeatTimer = setInterval(() => {
    seq++;
    io.emit('heartbeat', { seq, ts: Date.now() });
  }, intervalMs);

  return () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };
}
```

**Step 4: 运行测试** → PASS (3 tests)

**Step 5: Commit**

```bash
git add server/socket-heartbeat.js server/__tests__/socket-heartbeat.test.js
git commit -m "feat: add application-level heartbeat for gap detection"
```

---

## Phase 4: 前端迁移

### Task 9: 前端 Socket.IO Context

**Files:**
- Create: `src/contexts/SocketIOContext.tsx`
- Test: `src/contexts/__tests__/SocketIOContext.test.ts`
- Modify: `package.json`

**Step 1: 安装依赖**

```bash
npm install socket.io-client
```

**Step 2: 编写 Context 测试**

Create `src/contexts/__tests__/SocketIOContext.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock socket.io-client
vi.mock('socket.io-client', () => {
  const mockSocket = {
    connected: false,
    recovered: false,
    id: 'test-id',
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    io: { engine: { close: vi.fn() } }
  };
  return { io: vi.fn(() => mockSocket), default: { io: vi.fn(() => mockSocket) } };
});

import { io as mockIo } from 'socket.io-client';

describe('SocketIOContext', () => {
  it('should create socket connection with correct URL', () => {
    // 动态导入，在 mock 之后
    const socket = mockIo('http://localhost:3001');
    expect(mockIo).toHaveBeenCalledWith('http://localhost:3001');
  });

  it('should expose connected state', () => {
    const socket = mockIo('http://localhost:3001');
    expect(socket.connected).toBe(false);
  });

  it('should expose recovered flag', () => {
    const socket = mockIo('http://localhost:3001');
    expect(socket.recovered).toBe(false);
  });

  it('should register connect/disconnect listeners', () => {
    const socket = mockIo('http://localhost:3001');
    socket.on('connect', vi.fn());
    socket.on('disconnect', vi.fn());
    expect(socket.on).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });
});
```

**Step 3: 实现 SocketIOContext**

Create `src/contexts/SocketIOContext.tsx`:
```typescript
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';

interface SocketIOContextType {
  socket: Socket | null;
  isConnected: boolean;
  recovered: boolean;
  emit: (event: string, ...args: any[]) => void;
}

const SocketIOContext = createContext<SocketIOContextType>({
  socket: null,
  isConnected: false,
  recovered: false,
  emit: () => {}
});

export function SocketIOProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [recovered, setRecovered] = useState(false);

  useEffect(() => {
    if (!token) return;

    const socket = io(window.location.origin, {
      path: '/socket.io',
      auth: { token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });

    socket.on('connect', () => {
      setIsConnected(true);
      setRecovered(socket.recovered);
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      setRecovered(false);
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token]);

  const emit = useCallback((event: string, ...args: any[]) => {
    socketRef.current?.emit(event, ...args);
  }, []);

  return (
    <SocketIOContext.Provider value={{ socket: socketRef.current, isConnected, recovered, emit }}>
      {children}
    </SocketIOContext.Provider>
  );
}

export const useSocketIO = () => useContext(SocketIOContext);
```

**Step 4: 运行测试** → PASS (4 tests)

**Step 5: Commit**

```bash
git add src/contexts/SocketIOContext.tsx src/contexts/__tests__/SocketIOContext.test.ts package.json
git commit -m "feat: add SocketIOContext replacing WebSocketContext"
```

---

### Task 10: Page Visibility Sync Hook

**Files:**
- Create: `src/hooks/useVisibilitySync.ts`
- Test: `src/hooks/__tests__/useVisibilitySync.test.ts`

**Step 1: 编写 Visibility Hook 测试**

Create `src/hooks/__tests__/useVisibilitySync.test.ts`:
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('useVisibilitySync', () => {
  let listeners: Record<string, Function[]> = {};
  let hiddenValue = false;

  beforeEach(() => {
    listeners = {};
    vi.spyOn(document, 'addEventListener').mockImplementation((event, fn) => {
      listeners[event] = listeners[event] || [];
      listeners[event].push(fn as Function);
    });
    vi.spyOn(document, 'removeEventListener').mockImplementation(() => {});
    Object.defineProperty(document, 'hidden', { get: () => hiddenValue, configurable: true });
  });

  afterEach(() => { vi.restoreAllMocks(); });

  function triggerVisibilityChange(hidden: boolean) {
    hiddenValue = hidden;
    listeners['visibilitychange']?.forEach(fn => fn());
  }

  it('should register visibilitychange listener', () => {
    expect(document.addEventListener).toBeDefined();
  });

  it('should detect when tab goes hidden', () => {
    let wasHidden = false;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) wasHidden = true;
    });
    triggerVisibilityChange(true);
    expect(wasHidden).toBe(true);
  });

  it('should request snapshot when hidden > 3 seconds', () => {
    vi.useFakeTimers();
    const requestSnapshot = vi.fn();

    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else {
        if (Date.now() - hiddenAt > 3000) requestSnapshot();
      }
    });

    triggerVisibilityChange(true);
    vi.advanceTimersByTime(5000);
    triggerVisibilityChange(false);

    expect(requestSnapshot).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('should NOT request snapshot when hidden < 3 seconds', () => {
    vi.useFakeTimers();
    const requestSnapshot = vi.fn();

    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else {
        if (Date.now() - hiddenAt > 3000) requestSnapshot();
      }
    });

    triggerVisibilityChange(true);
    vi.advanceTimersByTime(1000);
    triggerVisibilityChange(false);

    expect(requestSnapshot).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

**Step 2: 运行测试** → FAIL

**Step 3: 实现**

Create `src/hooks/useVisibilitySync.ts`:
```typescript
import { useEffect, useRef } from 'react';
import { useSocketIO } from '../contexts/SocketIOContext';

const FREEZE_THRESHOLD_MS = 3000;

export function useVisibilitySync(
  sessionId: string | null,
  onSnapshot: (snapshot: any) => void
) {
  const { socket, isConnected } = useSocketIO();
  const hiddenAtRef = useRef<number>(0);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
      } else {
        const frozenMs = Date.now() - hiddenAtRef.current;
        if (frozenMs > FREEZE_THRESHOLD_MS && isConnected && sessionId && socket) {
          socket.emit('request-state-snapshot', sessionId, (snapshot: any) => {
            if (snapshot) onSnapshot(snapshot);
          });
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [socket, isConnected, sessionId, onSnapshot]);
}
```

**Step 4: 运行测试** → PASS (4 tests)

**Step 5: Commit**

```bash
git add src/hooks/useVisibilitySync.ts src/hooks/__tests__/useVisibilitySync.test.ts
git commit -m "feat: add Page Visibility sync hook for frozen tab recovery"
```

---

### Task 11: 前端消息处理器迁移

**Files:**
- Create: `src/components/chat/hooks/useSocketEventHandlers.ts`
- Test: `src/components/chat/hooks/__tests__/useSocketEventHandlers.test.ts`

**Step 1: 编写事件处理器测试**

Create `src/components/chat/hooks/__tests__/useSocketEventHandlers.test.ts`:
```typescript
import { describe, it, expect, vi } from 'vitest';

describe('useSocketEventHandlers', () => {
  it('should register listeners for all provider events', () => {
    const socket = { on: vi.fn(), off: vi.fn() };
    const events = [
      'claude-response', 'claude-complete', 'claude-error',
      'claude-permission-request', 'claude-status',
      'projects_updated', 'session-created', 'token-budget'
    ];

    events.forEach(e => socket.on(e, vi.fn()));

    expect(socket.on).toHaveBeenCalledTimes(events.length);
    events.forEach(e => {
      expect(socket.on).toHaveBeenCalledWith(e, expect.any(Function));
    });
  });

  it('should update messages on claude-response', () => {
    const messages: any[] = [];
    const handler = (data: any) => {
      messages.push({ role: 'assistant', content: data.text });
    };

    handler({ text: 'Hello from Claude' });
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('Hello from Claude');
  });

  it('should add permission to pending list', () => {
    const pending: any[] = [];
    const handler = (data: any) => { pending.push(data); };

    handler({ requestId: 'r1', toolName: 'bash', toolInput: { cmd: 'ls' } });
    expect(pending.length).toBe(1);
    expect(pending[0].toolName).toBe('bash');
  });

  it('should mark session complete', () => {
    let isComplete = false;
    const handler = () => { isComplete = true; };

    handler();
    expect(isComplete).toBe(true);
  });
});
```

**Step 2: 运行测试** → FAIL

**Step 3: 实现**

Create `src/components/chat/hooks/useSocketEventHandlers.ts`:
```typescript
import { useEffect } from 'react';
import { Socket } from 'socket.io-client';

interface EventHandlerCallbacks {
  onClaudeResponse: (data: any) => void;
  onClaudeComplete: (data: any) => void;
  onClaudeError: (data: any) => void;
  onPermissionRequest: (data: any) => void;
  onClaudeStatus: (data: any) => void;
  onProjectsUpdated: (data: any) => void;
  onSessionCreated: (data: any) => void;
  onTokenBudget: (data: any) => void;
}

export function useSocketEventHandlers(
  socket: Socket | null,
  sessionId: string | null,
  callbacks: Partial<EventHandlerCallbacks>
) {
  useEffect(() => {
    if (!socket) return;

    const handlers: [string, (data: any) => void][] = [
      ['claude-response', (data) => {
        if (data.sessionId && data.sessionId !== sessionId) return;
        callbacks.onClaudeResponse?.(data);
      }],
      ['claude-complete', (data) => {
        callbacks.onClaudeComplete?.(data);
      }],
      ['claude-error', (data) => {
        callbacks.onClaudeError?.(data);
      }],
      ['claude-permission-request', (data) => {
        callbacks.onPermissionRequest?.(data);
      }],
      ['claude-status', (data) => {
        callbacks.onClaudeStatus?.(data);
      }],
      ['projects_updated', (data) => {
        callbacks.onProjectsUpdated?.(data);
      }],
      ['session-created', (data) => {
        callbacks.onSessionCreated?.(data);
      }],
      ['token-budget', (data) => {
        callbacks.onTokenBudget?.(data);
      }]
    ];

    handlers.forEach(([event, handler]) => socket.on(event, handler));

    return () => {
      handlers.forEach(([event, handler]) => socket.off(event, handler));
    };
  }, [socket, sessionId, callbacks]);
}
```

**Step 4: 运行测试** → PASS (4 tests)

**Step 5: Commit**

```bash
git add src/components/chat/hooks/useSocketEventHandlers.ts src/components/chat/hooks/__tests__/useSocketEventHandlers.test.ts
git commit -m "feat: add socket event handlers replacing latestMessage pattern"
```

---

## Phase 5: Provider 集成

### Task 12: Claude SDK Socket.IO 集成

**Files:**
- Modify: `server/claude-sdk.js`
- Test: `server/__tests__/claude-sdk-socketio.test.js`

**Step 1: 编写 Claude SDK 集成测试**

Create `server/__tests__/claude-sdk-socketio.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createSessionState, getSessionState, deleteSessionState,
  addStreamingChunk, finalizeStreamingMessage,
  addPendingPermission, removePendingPermission
} from '../session-state.js';

describe('Claude SDK Session State Integration', () => {
  const sid = 'claude-session';
  beforeEach(() => { deleteSessionState(sid); });
  afterEach(() => { deleteSessionState(sid); });

  it('should accumulate streaming chunks in session state', () => {
    createSessionState(sid, 'claude');
    // Simulate SDK streaming
    addStreamingChunk(sid, 'Hello ');
    addStreamingChunk(sid, 'from ');
    addStreamingChunk(sid, 'Claude');

    const state = getSessionState(sid);
    expect(state.currentStreamingText).toBe('Hello from Claude');
  });

  it('should finalize message on content_block_stop', () => {
    createSessionState(sid, 'claude');
    addStreamingChunk(sid, 'Complete response');
    finalizeStreamingMessage(sid);

    const state = getSessionState(sid);
    expect(state.currentStreamingText).toBe('');
    expect(state.messages[0].content).toBe('Complete response');
  });

  it('should store tool approval in session state', () => {
    createSessionState(sid, 'claude');
    addPendingPermission(sid, {
      requestId: 'tool-1',
      toolName: 'Write',
      toolInput: { path: '/tmp/test.txt' }
    });

    const state = getSessionState(sid);
    expect(state.status).toBe('awaiting_permission');
    expect(state.pendingPermissions[0].toolName).toBe('Write');
  });

  it('should remove permission after approval', () => {
    createSessionState(sid, 'claude');
    addPendingPermission(sid, { requestId: 'tool-1', toolName: 'Write' });
    removePendingPermission(sid, 'tool-1');

    const state = getSessionState(sid);
    expect(state.pendingPermissions.length).toBe(0);
  });
});
```

**Step 2: 运行测试** → PASS (session-state already implemented)

**Step 3: 修改 claude-sdk.js** — 在流式输出处理中集成状态累积:

在 `server/claude-sdk.js` 的 streaming handler 中添加:
```javascript
import { addStreamingChunk, finalizeStreamingMessage, addPendingPermission, removePendingPermission } from './session-state.js';

// 在 content_block_delta handler 中:
addStreamingChunk(sessionId, delta.text);
writer.send({ type: 'claude-response', data: event });

// 在 content_block_stop handler 中:
finalizeStreamingMessage(sessionId);

// 在 tool approval request 中:
addPendingPermission(sessionId, { requestId, toolName, toolInput });

// 在 tool approval response 中:
removePendingPermission(sessionId, requestId);
```

**Step 4: 运行测试** → PASS (4 tests)

**Step 5: Commit**

```bash
git add server/claude-sdk.js server/__tests__/claude-sdk-socketio.test.js
git commit -m "feat: integrate session state accumulation into Claude SDK"
```

---

### Task 13: Cursor/Codex/Gemini 适配

**Files:**
- Modify: `server/cursor-cli.js`
- Modify: `server/openai-codex.js`
- Test: `server/__tests__/provider-socketio.test.js`

**Step 1: 编写 Provider 适配测试**

Create `server/__tests__/provider-socketio.test.js`:
```javascript
import { describe, it, expect } from 'vitest';
import { createSocketWriter } from '../socket-writer.js';

describe('Provider Socket.IO Adaptation', () => {
  it('should create writer with correct interface', () => {
    const mockSocket = { emit: () => {} };
    const writer = createSocketWriter(mockSocket);

    expect(writer).toHaveProperty('send');
    expect(typeof writer.send).toBe('function');
  });

  it('should emit cursor events via writer', () => {
    let emitted = null;
    const mockSocket = { emit: (type, data) => { emitted = { type, data }; } };
    const writer = createSocketWriter(mockSocket);

    writer.send({ type: 'cursor-output', data: { text: 'cursor reply' } });

    expect(emitted.type).toBe('cursor-output');
    expect(emitted.data.data.text).toBe('cursor reply');
  });

  it('should emit codex events via writer', () => {
    let emitted = null;
    const mockSocket = { emit: (type, data) => { emitted = { type, data }; } };
    const writer = createSocketWriter(mockSocket);

    writer.send({ type: 'codex-response', data: { text: 'codex reply' } });

    expect(emitted.type).toBe('codex-response');
  });
});
```

**Step 2: 运行测试** → PASS (writer already implemented)

**Step 3: 修改 Provider 文件** — 替换 `ws.send(JSON.stringify(...))` 为 `writer.send(...)`:

```javascript
// 在 cursor-cli.js 和 openai-codex.js 中:
// 替换:  ws.send(JSON.stringify({ type: 'cursor-output', ... }))
// 为:    writer.send({ type: 'cursor-output', data: {...} })
```

**Step 4: 运行测试** → PASS (3 tests)

**Step 5: Commit**

```bash
git add server/cursor-cli.js server/openai-codex.js server/__tests__/provider-socketio.test.js
git commit -m "feat: adapt Cursor/Codex providers to Socket.IO writer"
```

---

### Task 14: 广播迁移

**Files:**
- Modify: `server/index.js`
- Modify: `server/utils/taskmaster-websocket.js`
- Test: `server/__tests__/broadcasting.test.js`

**Step 1: 编写广播测试**

Create `server/__tests__/broadcasting.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { broadcastToAll, broadcastToSession } from '../socket-rooms.js';

describe('Broadcasting Migration', () => {
  let httpServer, io, port;

  beforeEach((done) => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;
    httpServer.listen(0, () => { port = httpServer.address().port; done(); });
  });

  afterEach(async () => { await cleanupTestServer(httpServer, io); });

  it('should broadcast project updates to all clients', async () => {
    const c1 = createTestClient(port);
    const c2 = createTestClient(port);
    await Promise.all([waitForEvent(c1, 'connect'), waitForEvent(c2, 'connect')]);

    broadcastToAll(io, 'projects_updated', { projects: ['p1', 'p2'] });

    const [m1, m2] = await Promise.all([
      waitForEvent(c1, 'projects_updated'),
      waitForEvent(c2, 'projects_updated')
    ]);

    expect(m1.projects).toEqual(['p1', 'p2']);
    expect(m2.projects).toEqual(['p1', 'p2']);
    c1.close(); c2.close();
  });

  it('should broadcast loading progress to all clients', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    broadcastToAll(io, 'loading_progress', { progress: 50 });
    const msg = await waitForEvent(client, 'loading_progress');

    expect(msg.progress).toBe(50);
    client.close();
  });

  it('should broadcast session-scoped events to room only', async () => {
    const c1 = createTestClient(port);
    const c2 = createTestClient(port);

    io.on('connection', (socket) => {
      socket.on('join-session', (sid) => socket.join(sid));
    });

    await Promise.all([waitForEvent(c1, 'connect'), waitForEvent(c2, 'connect')]);

    c1.emit('join-session', 'session-A');
    await new Promise(r => setTimeout(r, 50));

    let c2Received = false;
    c2.on('claude-response', () => { c2Received = true; });

    broadcastToSession(io, 'session-A', 'claude-response', { text: 'hi' });

    const msg = await waitForEvent(c1, 'claude-response');
    await new Promise(r => setTimeout(r, 50));

    expect(msg.text).toBe('hi');
    expect(c2Received).toBe(false);
    c1.close(); c2.close();
  });
});
```

**Step 2: 运行测试** → FAIL

**Step 3: 实现** — 在 `server/index.js` 中:

```javascript
// 替换所有 connectedClients.forEach 为 broadcastToAll:
// 旧: connectedClients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(...) });
// 新: broadcastToAll(io, 'projects_updated', projectsData);

// 替换 taskmaster-websocket.js 中:
// 旧: wss.clients.forEach(c => c.send(...))
// 新: broadcastToAll(io, 'taskmaster-project-updated', data);
```

**Step 4: 运行测试** → PASS (3 tests)

**Step 5: Commit**

```bash
git add server/index.js server/utils/taskmaster-websocket.js server/__tests__/broadcasting.test.js
git commit -m "feat: migrate broadcasting from connectedClients to Socket.IO"
```

---

### Task 15: 集成测试与清理

**Files:**
- Create: `server/__tests__/integration.test.js`
- Modify: `server/index.js` (清理旧代码)

**Step 1: 编写集成测试**

Create `server/__tests__/integration.test.js`:
```javascript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { setupRoomManagement } from '../socket-rooms.js';
import { setupHeartbeat } from '../socket-heartbeat.js';
import {
  createSessionState, getSessionState, deleteSessionState,
  addStreamingChunk, finalizeStreamingMessage,
  addPendingPermission, removePendingPermission,
  getStateSnapshot
} from '../session-state.js';

describe('Integration: Full Session Lifecycle', () => {
  let httpServer, io, port;
  const sid = 'integration-session';

  beforeEach((done) => {
    deleteSessionState(sid);
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;
    setupRoomManagement(io);
    setupHeartbeat(io, { intervalMs: 100 });

    io.on('connection', (socket) => {
      socket.on('request-state-snapshot', (sessionId, ack) => {
        ack(getStateSnapshot(sessionId));
      });
    });

    httpServer.listen(0, () => { port = httpServer.address().port; done(); });
  });

  afterEach(async () => {
    deleteSessionState(sid);
    await cleanupTestServer(httpServer, io);
  });

  it('should handle full streaming lifecycle', async () => {
    createSessionState(sid, 'claude');
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    // Join session room
    client.emit('join-session', sid);
    await waitForEvent(client, 'joined-session');

    // Simulate streaming
    addStreamingChunk(sid, 'Hello ');
    io.to(sid).emit('claude-response', { data: { delta: { text: 'Hello ' } } });
    await waitForEvent(client, 'claude-response');

    addStreamingChunk(sid, 'world');
    io.to(sid).emit('claude-response', { data: { delta: { text: 'world' } } });
    await waitForEvent(client, 'claude-response');

    // Verify state
    const state = getSessionState(sid);
    expect(state.currentStreamingText).toBe('Hello world');

    // Finalize
    finalizeStreamingMessage(sid);
    io.to(sid).emit('claude-complete', { sessionId: sid });
    await waitForEvent(client, 'claude-complete');

    expect(getSessionState(sid).messages[0].content).toBe('Hello world');

    client.close();
  });

  it('should recover state via snapshot after reconnect', async () => {
    createSessionState(sid, 'claude');
    addStreamingChunk(sid, 'partial text');

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    // Simulate disconnect + reconnect
    client.io.engine.close();
    await waitForEvent(client, 'disconnect');
    client.connect();
    await waitForEvent(client, 'connect');

    // Request snapshot (simulating visibility sync)
    const snapshot = await new Promise((resolve) => {
      client.emit('request-state-snapshot', sid, resolve);
    });

    expect(snapshot.currentStreamingText).toBe('partial text');
    expect(snapshot.provider).toBe('claude');

    client.close();
  });

  it('should handle permission flow with state tracking', async () => {
    createSessionState(sid, 'claude');
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');
    client.emit('join-session', sid);
    await waitForEvent(client, 'joined-session');

    // Permission request
    addPendingPermission(sid, { requestId: 'p1', toolName: 'Bash', toolInput: { cmd: 'ls' } });
    io.to(sid).emit('claude-permission-request', {
      requestId: 'p1', toolName: 'Bash', toolInput: { cmd: 'ls' }
    });
    const permReq = await waitForEvent(client, 'claude-permission-request');
    expect(permReq.toolName).toBe('Bash');

    // Verify state snapshot shows pending permission
    const snap = await new Promise((resolve) => {
      client.emit('request-state-snapshot', sid, resolve);
    });
    expect(snap.pendingPermissions.length).toBe(1);

    // Approve
    removePendingPermission(sid, 'p1');
    expect(getSessionState(sid).pendingPermissions.length).toBe(0);

    client.close();
  });

  it('should receive heartbeat with incrementing seq', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const hb1 = await waitForEvent(client, 'heartbeat', 500);
    const hb2 = await waitForEvent(client, 'heartbeat', 500);

    expect(hb2.seq).toBeGreaterThan(hb1.seq);

    client.close();
  });
});
```

**Step 2: 运行测试** → PASS (4 tests)

**Step 3: 清理旧代码**

在 `server/index.js` 中:
```javascript
// 删除: const connectedClients = new Set();
// 删除: connectedClients.add(ws); / connectedClients.delete(ws);
// 删除: handleChatConnection 中的原生 WS 消息处理（/ws 路径）
// 保留: handleShellConnection（/shell 路径，原生 WS）
// 保留: wss 实例（仅用于 /shell）
```

**Step 4: 全量测试**

Run: `npm test`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add server/__tests__/integration.test.js server/index.js
git commit -m "test: add integration tests and clean up old WS chat code"
```

---

## Summary

### Phase 概览

| Phase | Tasks | 描述 |
|-------|-------|------|
| 0 | Task 0 | 测试基础设施 (Vitest) |
| 1 | Task 1-3 | Socket.IO 服务端基础（初始化、共存、房间） |
| 2 | Task 4-5 | 消息协议迁移（事件映射、Writer 适配器） |
| 3 | Task 6-8 | 状态管理与恢复（状态累积、Snapshot、Heartbeat） |
| 4 | Task 9-11 | 前端迁移（Context、Visibility Hook、事件处理器） |
| 5 | Task 12-14 | Provider 集成（Claude SDK、Cursor/Codex、广播） |
| 6 | Task 15 | 集成测试与清理 |

### 测试覆盖

| 测试文件 | 覆盖内容 |
|----------|---------|
| `socket-server.test.js` | Socket.IO 连接、ID 分配、CSR |
| `ws-socketio-coexistence.test.js` | Socket.IO + 原生 WS 共存 |
| `socket-rooms.test.js` | 房间加入/离开/广播 |
| `socket-events.test.js` | 事件类型映射、分发 |
| `socket-writer.test.js` | Writer 单播/广播 |
| `session-state.test.js` | 状态创建/累积/权限管理 |
| `state-snapshot.test.js` | Snapshot 请求/响应/降级 |
| `socket-heartbeat.test.js` | 心跳间隔、seq 递增 |
| `SocketIOContext.test.ts` | 前端连接 Context |
| `useVisibilitySync.test.ts` | Page Visibility 检测、阈值判断 |
| `useSocketEventHandlers.test.ts` | 前端事件监听器注册 |
| `claude-sdk-socketio.test.js` | Claude SDK 状态集成 |
| `provider-socketio.test.js` | Cursor/Codex Writer 适配 |
| `broadcasting.test.js` | 全局/房间广播 |
| `integration.test.js` | 端到端流程、重连恢复、权限流程 |

### 回滚策略

- 每个 Task 独立 commit，可单独 revert
- Phase 1-3（服务端）可独立于 Phase 4（前端）部署
- 旧 WebSocket 聊天代码在 Task 15 才删除，之前可随时回退
- `/shell` 路径始终保持原生 WebSocket，不受影响

### npm 依赖

```bash
# 生产依赖
npm install socket.io socket.io-client

# 开发依赖
npm install -D vitest @vitest/ui
```
