import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { setupRoomManagement, emitTaskEvent, ackEvent, syncPendingEvents } from '../socket-rooms.js';
import { backgroundTasks, backgroundTaskOutputs } from '../claude-sdk.js';

/**
 * End-to-end integration tests for the background task lifecycle.
 * Tests the full flow: task started → progress → completed → reconnect → state restore.
 * All handlers match the actual server/index.js implementation.
 */
describe('Background Task Lifecycle (E2E)', () => {
  let httpServer, io, port;

  beforeEach(async () => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;
    setupRoomManagement(io);

    // Register all handlers matching server/index.js
    io.on('connection', (socket) => {
      socket.on('query-task-output', (data) => {
        const { taskId, maxLines = 200 } = data || {};
        if (!taskId) return;

        const cached = backgroundTaskOutputs.get(taskId);
        let raw = '';
        if (cached?.content) {
          raw = cached.content;
        } else if (cached?.path) {
          // In tests we don't use file paths, but test the branch
          raw = '';
        }

        const lines = raw.split('\n');
        let output;
        if (lines.length <= maxLines) {
          output = { content: raw, truncated: false, totalLines: lines.length };
        } else {
          const truncatedLines = lines.slice(-maxLines);
          output = {
            content: truncatedLines.join('\n'),
            truncated: true,
            totalLines: lines.length,
            skippedLines: lines.length - maxLines
          };
        }
        socket.emit('task-output', { taskId, output });
      });

      socket.on('kill-task', async (data) => {
        const { taskId } = data || {};
        if (!taskId) return;
        const task = backgroundTasks.get(taskId);
        if (!task) {
          socket.emit('task-killed', { taskId, success: false });
          return;
        }
        task.status = 'completed';
        task.endTime = Date.now();
        socket.emit('task-killed', { taskId, success: true });
      });

      socket.on('ack-event', (data) => {
        const { eventId, sessionId } = data || {};
        if (eventId && sessionId) {
          ackEvent(sessionId, eventId);
        }
      });

      socket.on('sync-background-events', (data) => {
        const { sessionId } = data || {};
        if (sessionId) {
          syncPendingEvents(sessionId, socket);
        }
      });

      socket.on('query-active-tasks', (data, ack) => {
        if (typeof ack !== 'function') return;
        const { sessionId } = data || {};

        const sessionTasks = [];
        const sessionBashTasks = [];
        for (const [taskId, task] of backgroundTasks) {
          if (sessionId && task.sessionId !== sessionId) continue;
          if (task.toolName === 'Bash') {
            sessionBashTasks.push({
              id: taskId,
              command: task.input?.command || '',
              description: task.input?.description,
              run_in_background: true,
              startTime: task.startTime,
              sessionId: task.sessionId,
              status: task.status === 'completed' ? 'completed' : 'running',
              endTime: task.endTime
            });
          } else {
            sessionTasks.push(task);
          }
        }
        ack({ tasks: sessionTasks, bashTasks: sessionBashTasks });
      });
    });

    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        port = httpServer.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    backgroundTasks.clear();
    backgroundTaskOutputs.clear();
    await cleanupTestServer(httpServer, io);
  });

  // =========================================================================
  // Full subagent lifecycle
  // =========================================================================

  it('subagent lifecycle: started → progress → completed → query output', async () => {
    const sessionId = 'lifecycle-subagent';
    const taskId = 'sub-life-1';

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    // Track all received events
    const received = [];
    client.on('background-task-started', (data) => received.push({ type: 'background-task-started', ...data }));
    client.on('subagent-progress', (data) => received.push({ type: 'subagent-progress', ...data }));
    client.on('subagent-completed', (data) => received.push({ type: 'subagent-completed', ...data }));

    // 1. Task started — add to server state + emit event
    backgroundTasks.set(taskId, {
      taskId,
      toolName: 'Task',
      input: { description: 'explore codebase' },
      sessionId,
      startTime: Date.now(),
      status: 'running'
    });

    emitTaskEvent(sessionId, {
      type: 'background-task-started',
      task: backgroundTasks.get(taskId)
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(1);
    expect(received[0].type).toBe('background-task-started');
    expect(received[0].task.taskId).toBe(taskId);

    // 2. Progress update
    emitTaskEvent(sessionId, {
      type: 'subagent-progress',
      taskId,
      agentId: 'agent-explore',
      messages: [{ type: 'tool_use', tool: 'Grep', input: { pattern: 'TODO' } }]
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(2);
    expect(received[1].type).toBe('subagent-progress');
    expect(received[1].messages[0].tool).toBe('Grep');

    // 3. Task completed
    backgroundTasks.get(taskId).status = 'completed';
    backgroundTasks.get(taskId).endTime = Date.now();
    backgroundTaskOutputs.set(taskId, { content: 'Found 5 TODOs in the codebase.' });

    emitTaskEvent(sessionId, {
      type: 'subagent-completed',
      taskId,
      agentId: 'agent-explore',
      output: 'Found 5 TODOs in the codebase.'
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(3);
    expect(received[2].type).toBe('subagent-completed');
    expect(received[2].output).toBe('Found 5 TODOs in the codebase.');

    // 4. Query output — should return cached content
    const outputPromise = waitForEvent(client, 'task-output');
    client.emit('query-task-output', { taskId, maxLines: 100 });
    const output = await outputPromise;
    expect(output.taskId).toBe(taskId);
    expect(output.output.content).toBe('Found 5 TODOs in the codebase.');

    client.close();
  });

  // =========================================================================
  // Full bash lifecycle
  // =========================================================================

  it('bash lifecycle: started → completed → output query', async () => {
    const sessionId = 'lifecycle-bash';
    const bashId = 'bash-life-1';

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const received = [];
    client.on('bash-started', (data) => received.push({ type: 'bash-started', ...data }));
    client.on('bash-completed', (data) => received.push({ type: 'bash-completed', ...data }));

    // 1. Bash started
    backgroundTasks.set(bashId, {
      taskId: bashId,
      toolName: 'Bash',
      input: { command: 'npm test', run_in_background: true },
      sessionId,
      startTime: Date.now(),
      status: 'running'
    });

    emitTaskEvent(sessionId, {
      type: 'bash-started',
      bash: { id: bashId, command: 'npm test', run_in_background: true, startTime: Date.now() }
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(1);
    expect(received[0].type).toBe('bash-started');
    expect(received[0].bash.command).toBe('npm test');

    // 2. Bash completed
    backgroundTasks.get(bashId).status = 'completed';
    backgroundTasks.get(bashId).endTime = Date.now();
    backgroundTaskOutputs.set(bashId, { content: 'All 78 tests passed.' });

    emitTaskEvent(sessionId, {
      type: 'bash-completed',
      bash: { id: bashId, endTime: Date.now() },
      background: true,
      outputSnippet: 'All 78 tests passed.'
    });

    await new Promise((r) => setTimeout(r, 50));
    expect(received.length).toBe(2);
    expect(received[1].type).toBe('bash-completed');
    expect(received[1].bash.id).toBe(bashId);
    expect(received[1].outputSnippet).toBe('All 78 tests passed.');

    client.close();
  });

  // =========================================================================
  // Disconnect → Reconnect → State restore
  // =========================================================================

  it('disconnect → reconnect → query-active-tasks restores state', async () => {
    const sessionId = 'lifecycle-reconnect';

    // Seed server with tasks
    backgroundTasks.set('recon-sub-1', {
      taskId: 'recon-sub-1',
      toolName: 'Task',
      input: { description: 'long analysis' },
      sessionId,
      startTime: 1000,
      status: 'running'
    });
    backgroundTasks.set('recon-bash-1', {
      taskId: 'recon-bash-1',
      toolName: 'Bash',
      input: { command: 'npm run build', run_in_background: true },
      sessionId,
      startTime: 2000,
      status: 'completed',
      endTime: 3000
    });
    backgroundTasks.set('other-session', {
      taskId: 'other-session',
      toolName: 'Task',
      input: {},
      sessionId: 'different-session',
      startTime: 4000,
      status: 'running'
    });

    // Client 1 connects, receives events, then disconnects
    const client1 = createTestClient(port);
    await waitForEvent(client1, 'connect');
    client1.close();
    await new Promise((r) => setTimeout(r, 50));

    // Client 2 connects (simulating page refresh)
    const client2 = createTestClient(port);
    await waitForEvent(client2, 'connect');

    // Query active tasks for this session
    const result = await new Promise((resolve) => {
      client2.emit('query-active-tasks', { sessionId }, resolve);
    });

    // Should get tasks for this session only
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe('recon-sub-1');
    expect(result.tasks[0].status).toBe('running');

    expect(result.bashTasks).toHaveLength(1);
    expect(result.bashTasks[0].id).toBe('recon-bash-1');
    expect(result.bashTasks[0].status).toBe('completed');

    client2.close();
  });

  // =========================================================================
  // Event ACK + Sync flow
  // =========================================================================

  it('events survive disconnect and are redelivered via sync', async () => {
    const sessionId = 'lifecycle-sync';

    // Emit events while no client is connected
    emitTaskEvent(sessionId, {
      type: 'bash-started',
      bash: { id: 'sync-bash-1', command: 'make', run_in_background: true, startTime: Date.now() }
    });
    emitTaskEvent(sessionId, {
      type: 'bash-completed',
      bash: { id: 'sync-bash-1', endTime: Date.now() },
      background: true,
      outputSnippet: 'Build successful'
    });

    // Client connects and requests sync
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');
    client.emit('join-session', sessionId);
    await waitForEvent(client, 'joined-session');

    const bashStarted = [];
    const bashCompleted = [];
    client.on('bash-started', (data) => bashStarted.push(data));
    client.on('bash-completed', (data) => bashCompleted.push(data));

    client.emit('sync-background-events', { sessionId });
    await new Promise((r) => setTimeout(r, 100));

    expect(bashStarted.length).toBe(1);
    expect(bashCompleted.length).toBe(1);
    expect(bashCompleted[0].outputSnippet).toBe('Build successful');

    // ACK the events
    client.emit('ack-event', { eventId: bashStarted[0].eventId, sessionId });
    client.emit('ack-event', { eventId: bashCompleted[0].eventId, sessionId });
    await new Promise((r) => setTimeout(r, 50));

    // Sync again — nothing should arrive (all ACK'd)
    const received2 = [];
    client.on('bash-started', (data) => received2.push(data));
    client.on('bash-completed', (data) => received2.push(data));
    client.emit('sync-background-events', { sessionId });
    await new Promise((r) => setTimeout(r, 100));

    expect(received2.length).toBe(0);

    client.close();
  });

  // =========================================================================
  // Kill task flow
  // =========================================================================

  it('kill-task marks task completed and returns success', async () => {
    const sessionId = 'lifecycle-kill';
    const taskId = 'kill-target';

    backgroundTasks.set(taskId, {
      taskId,
      toolName: 'Bash',
      input: { command: 'sleep 3600', run_in_background: true },
      sessionId,
      startTime: Date.now(),
      status: 'running'
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const resultPromise = waitForEvent(client, 'task-killed');
    client.emit('kill-task', { taskId });
    const result = await resultPromise;

    expect(result.success).toBe(true);
    expect(result.taskId).toBe(taskId);

    // Verify server state updated
    const task = backgroundTasks.get(taskId);
    expect(task.status).toBe('completed');
    expect(task.endTime).toBeDefined();

    // After kill, query-active-tasks should show it as completed
    const tasksResult = await new Promise((resolve) => {
      client.emit('query-active-tasks', { sessionId }, resolve);
    });

    expect(tasksResult.bashTasks[0].status).toBe('completed');

    client.close();
  });

  // =========================================================================
  // Broadcast-to-all ensures all clients receive events
  // =========================================================================

  it('events reach clients regardless of room membership', async () => {
    const sessionId = 'lifecycle-broadcast';

    const client1 = createTestClient(port);
    const client2 = createTestClient(port);
    await Promise.all([
      waitForEvent(client1, 'connect'),
      waitForEvent(client2, 'connect')
    ]);

    // Client 1 joins the session room, client 2 does NOT
    client1.emit('join-session', sessionId);
    await waitForEvent(client1, 'joined-session');

    // Both should receive the event (broadcast to all)
    const p1 = waitForEvent(client1, 'background-task-started');
    const p2 = waitForEvent(client2, 'background-task-started');

    emitTaskEvent(sessionId, {
      type: 'background-task-started',
      task: { taskId: 'broadcast-1', toolName: 'Task', status: 'running' }
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    expect(r1.task.taskId).toBe('broadcast-1');
    expect(r2.task.taskId).toBe('broadcast-1');
    // Both include sessionId for filtering
    expect(r1.sessionId).toBe(sessionId);
    expect(r2.sessionId).toBe(sessionId);

    client1.close();
    client2.close();
  });

  // =========================================================================
  // Multiple sessions don't interfere
  // =========================================================================

  it('query-active-tasks isolates tasks by session', async () => {
    // Populate tasks for two sessions
    backgroundTasks.set('s1-task', {
      taskId: 's1-task', toolName: 'Task', input: {}, sessionId: 'session-1', startTime: 1000, status: 'running'
    });
    backgroundTasks.set('s2-task', {
      taskId: 's2-task', toolName: 'Task', input: {}, sessionId: 'session-2', startTime: 2000, status: 'running'
    });
    backgroundTasks.set('s1-bash', {
      taskId: 's1-bash', toolName: 'Bash', input: { command: 'test' }, sessionId: 'session-1', startTime: 3000, status: 'running'
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const result1 = await new Promise((resolve) => {
      client.emit('query-active-tasks', { sessionId: 'session-1' }, resolve);
    });

    expect(result1.tasks).toHaveLength(1);
    expect(result1.tasks[0].taskId).toBe('s1-task');
    expect(result1.bashTasks).toHaveLength(1);
    expect(result1.bashTasks[0].id).toBe('s1-bash');

    const result2 = await new Promise((resolve) => {
      client.emit('query-active-tasks', { sessionId: 'session-2' }, resolve);
    });

    expect(result2.tasks).toHaveLength(1);
    expect(result2.tasks[0].taskId).toBe('s2-task');
    expect(result2.bashTasks).toEqual([]);

    client.close();
  });
});
