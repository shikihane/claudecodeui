import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { setupRoomManagement } from '../socket-rooms.js';
import { backgroundTasks } from '../claude-sdk.js';

/**
 * Tests for the query-active-tasks Socket.IO handler.
 * This handler returns all tasks from the backgroundTasks Map for a given session,
 * split into subagent tasks and bash tasks. Used on page refresh to rebuild UI state.
 */
describe('query-active-tasks handler', () => {
  let httpServer, io, port;

  beforeEach(async () => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;
    setupRoomManagement(io);

    // Register handler matching server/index.js
    io.on('connection', (socket) => {
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
    await cleanupTestServer(httpServer, io);
  });

  it('should return empty arrays when no tasks exist for the session', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const result = await new Promise((resolve) => {
      client.emit('query-active-tasks', { sessionId: 'empty-session' }, resolve);
    });

    expect(result.tasks).toEqual([]);
    expect(result.bashTasks).toEqual([]);

    client.close();
  });

  it('should return subagent tasks for the requested session', async () => {
    backgroundTasks.set('task-1', {
      taskId: 'task-1',
      toolName: 'Task',
      input: { description: 'research agent', prompt: 'find bugs' },
      sessionId: 'session-A',
      startTime: 1000,
      status: 'running'
    });

    backgroundTasks.set('task-2', {
      taskId: 'task-2',
      toolName: 'Task',
      input: { description: 'test agent' },
      sessionId: 'session-A',
      startTime: 2000,
      status: 'completed',
      endTime: 3000
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const result = await new Promise((resolve) => {
      client.emit('query-active-tasks', { sessionId: 'session-A' }, resolve);
    });

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].taskId).toBe('task-1');
    expect(result.tasks[0].status).toBe('running');
    expect(result.tasks[1].taskId).toBe('task-2');
    expect(result.tasks[1].status).toBe('completed');
    expect(result.bashTasks).toEqual([]);

    client.close();
  });

  it('should return bash tasks with correct fields', async () => {
    backgroundTasks.set('bash-1', {
      taskId: 'bash-1',
      toolName: 'Bash',
      input: { command: 'npm test', description: 'run tests', run_in_background: true },
      sessionId: 'session-B',
      startTime: 5000,
      status: 'running'
    });

    backgroundTasks.set('bash-2', {
      taskId: 'bash-2',
      toolName: 'Bash',
      input: { command: 'npm run build', run_in_background: true },
      sessionId: 'session-B',
      startTime: 6000,
      status: 'completed',
      endTime: 7000
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const result = await new Promise((resolve) => {
      client.emit('query-active-tasks', { sessionId: 'session-B' }, resolve);
    });

    expect(result.tasks).toEqual([]);
    expect(result.bashTasks).toHaveLength(2);

    const bash1 = result.bashTasks.find(b => b.id === 'bash-1');
    expect(bash1.command).toBe('npm test');
    expect(bash1.description).toBe('run tests');
    expect(bash1.run_in_background).toBe(true);
    expect(bash1.startTime).toBe(5000);
    expect(bash1.status).toBe('running');
    expect(bash1.sessionId).toBe('session-B');

    const bash2 = result.bashTasks.find(b => b.id === 'bash-2');
    expect(bash2.command).toBe('npm run build');
    expect(bash2.status).toBe('completed');
    expect(bash2.endTime).toBe(7000);

    client.close();
  });

  it('should NOT return tasks from a different session', async () => {
    backgroundTasks.set('task-other', {
      taskId: 'task-other',
      toolName: 'Task',
      input: { description: 'other session task' },
      sessionId: 'session-OTHER',
      startTime: 1000,
      status: 'running'
    });

    backgroundTasks.set('bash-other', {
      taskId: 'bash-other',
      toolName: 'Bash',
      input: { command: 'echo hello', run_in_background: true },
      sessionId: 'session-OTHER',
      startTime: 2000,
      status: 'running'
    });

    backgroundTasks.set('task-mine', {
      taskId: 'task-mine',
      toolName: 'Task',
      input: { description: 'my task' },
      sessionId: 'session-MINE',
      startTime: 3000,
      status: 'running'
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const result = await new Promise((resolve) => {
      client.emit('query-active-tasks', { sessionId: 'session-MINE' }, resolve);
    });

    // Only the task from session-MINE should be returned
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe('task-mine');
    expect(result.bashTasks).toEqual([]);

    client.close();
  });

  it('should return mixed subagent and bash tasks for the same session', async () => {
    backgroundTasks.set('subagent-1', {
      taskId: 'subagent-1',
      toolName: 'Task',
      input: { description: 'explore agent' },
      sessionId: 'session-mixed',
      startTime: 1000,
      status: 'running'
    });

    backgroundTasks.set('bash-bg-1', {
      taskId: 'bash-bg-1',
      toolName: 'Bash',
      input: { command: 'sleep 60', run_in_background: true },
      sessionId: 'session-mixed',
      startTime: 2000,
      status: 'running'
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const result = await new Promise((resolve) => {
      client.emit('query-active-tasks', { sessionId: 'session-mixed' }, resolve);
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].taskId).toBe('subagent-1');
    expect(result.bashTasks).toHaveLength(1);
    expect(result.bashTasks[0].id).toBe('bash-bg-1');

    client.close();
  });

  it('should map "monitoring" status to "running" for bash tasks', async () => {
    backgroundTasks.set('bash-monitor', {
      taskId: 'bash-monitor',
      toolName: 'Bash',
      input: { command: 'long-running-cmd', run_in_background: true },
      sessionId: 'session-status',
      startTime: 1000,
      status: 'monitoring'
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const result = await new Promise((resolve) => {
      client.emit('query-active-tasks', { sessionId: 'session-status' }, resolve);
    });

    // 'monitoring' is not 'completed', so it should map to 'running'
    expect(result.bashTasks[0].status).toBe('running');

    client.close();
  });

  it('should not respond when no ack callback is provided', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    // Emit without callback — handler should silently return
    client.emit('query-active-tasks', { sessionId: 'no-ack' });

    // Wait to ensure no crash or error
    await new Promise((resolve) => setTimeout(resolve, 100));

    client.close();
  });

  it('should return ALL tasks when sessionId is omitted', async () => {
    backgroundTasks.set('task-A', {
      taskId: 'task-A',
      toolName: 'Task',
      input: { description: 'session A task' },
      sessionId: 'session-A',
      startTime: 1000,
      status: 'running'
    });

    backgroundTasks.set('bash-B', {
      taskId: 'bash-B',
      toolName: 'Bash',
      input: { command: 'echo hi', run_in_background: true },
      sessionId: 'session-B',
      startTime: 2000,
      status: 'running'
    });

    backgroundTasks.set('task-C', {
      taskId: 'task-C',
      toolName: 'Task',
      input: { description: 'session C task' },
      sessionId: 'session-C',
      startTime: 3000,
      status: 'completed',
      endTime: 4000
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    // No sessionId → return all tasks across all sessions
    const result = await new Promise((resolve) => {
      client.emit('query-active-tasks', {}, resolve);
    });

    expect(result.tasks).toHaveLength(2); // task-A + task-C
    expect(result.bashTasks).toHaveLength(1); // bash-B
    expect(result.tasks.map(t => t.taskId).sort()).toEqual(['task-A', 'task-C']);
    expect(result.bashTasks[0].id).toBe('bash-B');

    client.close();
  });
});
