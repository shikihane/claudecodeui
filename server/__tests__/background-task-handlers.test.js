import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { setupRoomManagement, emitTaskEvent, ackEvent, syncPendingEvents } from '../socket-rooms.js';
import { backgroundTasks, backgroundTaskOutputs } from '../claude-sdk.js';

/**
 * Tests for the Socket.IO event handlers that were previously missing:
 * - query-task-output
 * - kill-task (partial — full kill needs process spawning)
 * - ack-event
 * - sync-background-events
 */
describe('Background Task Socket.IO Handlers', () => {
  let httpServer, io, port;

  beforeEach(async () => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;
    setupRoomManagement(io);

    // Register the handlers matching server/index.js
    io.on('connection', (socket) => {
      socket.on('query-task-output', (data) => {
        const { taskId, maxLines = 200 } = data || {};
        if (!taskId) return;

        const cached = backgroundTaskOutputs.get(taskId);
        const raw = cached?.content || '';

        // Inline truncateOutput logic (same as index.js)
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

        // In test, we can't actually kill processes, but we verify the handler logic
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
    });

    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        port = httpServer.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    // Clean up test data
    backgroundTasks.clear();
    backgroundTaskOutputs.clear();
    await cleanupTestServer(httpServer, io);
  });

  // --- query-task-output ---

  it('query-task-output should return cached output', async () => {
    // Seed the output cache
    backgroundTaskOutputs.set('task-out-1', {
      content: 'line1\nline2\nline3'
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const resultPromise = waitForEvent(client, 'task-output');
    client.emit('query-task-output', { taskId: 'task-out-1', maxLines: 200 });

    const result = await resultPromise;
    expect(result.taskId).toBe('task-out-1');
    expect(result.output.content).toBe('line1\nline2\nline3');
    expect(result.output.truncated).toBe(false);
    expect(result.output.totalLines).toBe(3);

    client.close();
  });

  it('query-task-output should truncate when output exceeds maxLines', async () => {
    // Generate 10 lines of output
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    backgroundTaskOutputs.set('task-out-trunc', {
      content: lines.join('\n')
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const resultPromise = waitForEvent(client, 'task-output');
    client.emit('query-task-output', { taskId: 'task-out-trunc', maxLines: 3 });

    const result = await resultPromise;
    expect(result.output.truncated).toBe(true);
    expect(result.output.totalLines).toBe(10);
    expect(result.output.skippedLines).toBe(7);
    // Should keep the last 3 lines
    expect(result.output.content).toBe('line 8\nline 9\nline 10');

    client.close();
  });

  it('query-task-output should return empty content for unknown task', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const resultPromise = waitForEvent(client, 'task-output');
    client.emit('query-task-output', { taskId: 'nonexistent', maxLines: 50 });

    const result = await resultPromise;
    expect(result.taskId).toBe('nonexistent');
    expect(result.output.content).toBe('');
    expect(result.output.truncated).toBe(false);

    client.close();
  });

  // --- kill-task ---

  it('kill-task should mark task as completed', async () => {
    backgroundTasks.set('task-kill-1', {
      taskId: 'task-kill-1',
      toolName: 'Bash',
      input: { command: 'sleep 999' },
      status: 'running',
      startTime: Date.now()
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const resultPromise = waitForEvent(client, 'task-killed');
    client.emit('kill-task', { taskId: 'task-kill-1' });

    const result = await resultPromise;
    expect(result.taskId).toBe('task-kill-1');
    expect(result.success).toBe(true);

    // Verify status changed
    const task = backgroundTasks.get('task-kill-1');
    expect(task.status).toBe('completed');
    expect(task.endTime).toBeDefined();

    client.close();
  });

  it('kill-task should return failure for unknown task', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const resultPromise = waitForEvent(client, 'task-killed');
    client.emit('kill-task', { taskId: 'nonexistent-task' });

    const result = await resultPromise;
    expect(result.taskId).toBe('nonexistent-task');
    expect(result.success).toBe(false);

    client.close();
  });

  // --- ack-event + sync-background-events ---

  it('ack-event via Socket.IO should remove event from pending queue', async () => {
    const sessionId = 'session-handler-ack';

    // Emit event to pending queue
    emitTaskEvent(sessionId, {
      type: 'background-task-started',
      task: { taskId: 'handler-ack-task' }
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');
    client.emit('join-session', sessionId);
    await waitForEvent(client, 'joined-session');

    // Sync to get the pending event
    const received = [];
    client.on('background-task-started', (data) => received.push(data));
    client.emit('sync-background-events', { sessionId });

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.length).toBe(1);
    expect(received[0].task.taskId).toBe('handler-ack-task');

    // ACK the event via the handler
    client.emit('ack-event', { eventId: received[0].eventId, sessionId });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Sync again — should get nothing
    const received2 = [];
    const listener = (data) => received2.push(data);
    client.on('background-task-started', listener);
    client.emit('sync-background-events', { sessionId });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received2.length).toBe(0);

    client.close();
  });

  it('sync-background-events should resend all pending events for session', async () => {
    const sessionId = 'session-handler-sync';

    // Emit multiple events
    emitTaskEvent(sessionId, {
      type: 'bash-completed',
      bash: { id: 'bash-sync-1' }
    });
    emitTaskEvent(sessionId, {
      type: 'subagent-completed',
      agentId: 'agent-sync-1',
      taskId: 'task-sync-1',
      output: 'done'
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');
    client.emit('join-session', sessionId);
    await waitForEvent(client, 'joined-session');

    const bashReceived = [];
    const subagentReceived = [];
    client.on('bash-completed', (data) => bashReceived.push(data));
    client.on('subagent-completed', (data) => subagentReceived.push(data));

    client.emit('sync-background-events', { sessionId });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(bashReceived.length).toBe(1);
    expect(bashReceived[0].bash.id).toBe('bash-sync-1');
    expect(subagentReceived.length).toBe(1);
    expect(subagentReceived[0].agentId).toBe('agent-sync-1');

    client.close();
  });
});
