import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { setupRoomManagement, emitTaskEvent, ackEvent, syncPendingEvents } from '../socket-rooms.js';

describe('Pending Events (at-least-once delivery)', () => {
  let httpServer, io, port;

  beforeEach(async () => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;
    setupRoomManagement(io);

    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        port = httpServer.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    await cleanupTestServer(httpServer, io);
  });

  it('emitTaskEvent should deliver event to session room via Socket.IO', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const sessionId = 'session-emit-test';
    client.emit('join-session', sessionId);
    await waitForEvent(client, 'joined-session');

    const receivedPromise = waitForEvent(client, 'background-task-started');

    emitTaskEvent(sessionId, {
      type: 'background-task-started',
      task: { taskId: 'task-1', toolName: 'Task', status: 'running' }
    });

    const received = await receivedPromise;
    expect(received.task.taskId).toBe('task-1');
    expect(received.task.toolName).toBe('Task');
    expect(received.sessionId).toBe(sessionId);
    expect(received.eventId).toBeDefined();

    client.close();
  });

  it('emitTaskEvent should broadcast to ALL clients with sessionId for filtering', async () => {
    const client1 = createTestClient(port);
    const client2 = createTestClient(port);
    await Promise.all([
      waitForEvent(client1, 'connect'),
      waitForEvent(client2, 'connect')
    ]);

    const client1Promise = waitForEvent(client1, 'subagent-completed');
    const client2Promise = waitForEvent(client2, 'subagent-completed');

    emitTaskEvent('session-A', {
      type: 'subagent-completed',
      agentId: 'agent-1',
      taskId: 'task-1',
      output: 'done'
    });

    const [received1, received2] = await Promise.all([client1Promise, client2Promise]);

    // Both clients receive the event (broadcast to all)
    expect(received1.agentId).toBe('agent-1');
    expect(received2.agentId).toBe('agent-1');

    // sessionId is included so clients can filter by session
    expect(received1.sessionId).toBe('session-A');
    expect(received2.sessionId).toBe('session-A');

    client1.close();
    client2.close();
  });

  it('ackEvent should remove event so sync does not resend it', async () => {
    const sessionId = 'session-ack-test';

    // Emit an event (no client in room, goes to pending queue only)
    emitTaskEvent(sessionId, {
      type: 'background-task-completed',
      taskId: 'task-ack'
    });

    // Connect a client and join the session
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');
    client.emit('join-session', sessionId);
    await waitForEvent(client, 'joined-session');

    // Sync should resend the pending event
    const sockets = await io.in(sessionId).fetchSockets();
    const received = [];
    client.on('background-task-completed', (data) => received.push(data));

    syncPendingEvents(sessionId, sockets[0]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received.length).toBe(1);

    // ACK the event
    ackEvent(sessionId, received[0].eventId);

    // Sync again — should NOT resend (queue empty)
    const received2 = [];
    client.on('background-task-completed', (data) => received2.push(data));

    syncPendingEvents(sessionId, sockets[0]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // No new events should arrive (received2 should be empty)
    // But the listener from above will also fire, so count total from this point
    expect(received2.length).toBe(0);

    client.close();
  });

  it('syncPendingEvents should resend un-ACKd events to reconnecting socket', async () => {
    const sessionId = 'session-sync-test';

    // Emit 2 events while no client is connected to the room
    emitTaskEvent(sessionId, {
      type: 'background-task-started',
      task: { taskId: 'sync-1' }
    });
    emitTaskEvent(sessionId, {
      type: 'subagent-completed',
      agentId: 'agent-sync',
      taskId: 'sync-2',
      output: 'result'
    });

    // Client connects and joins session
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');
    client.emit('join-session', sessionId);
    await waitForEvent(client, 'joined-session');

    const received = [];
    client.on('background-task-started', (data) => received.push({ type: 'background-task-started', ...data }));
    client.on('subagent-completed', (data) => received.push({ type: 'subagent-completed', ...data }));

    const sockets = await io.in(sessionId).fetchSockets();
    expect(sockets.length).toBe(1);

    syncPendingEvents(sessionId, sockets[0]);

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received.length).toBe(2);
    expect(received.find(e => e.type === 'background-task-started').task.taskId).toBe('sync-1');
    expect(received.find(e => e.type === 'subagent-completed').agentId).toBe('agent-sync');

    client.close();
  });

  it('emitTaskEvent should store in pending queue even with no connected clients', async () => {
    // No client connected — events should be stored for later sync
    emitTaskEvent('orphan-session', {
      type: 'bash-completed',
      bash: { id: 'orphan-1' }
    });

    // Now connect and sync — events should arrive
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');
    client.emit('join-session', 'orphan-session');
    await waitForEvent(client, 'joined-session');

    const received = [];
    client.on('bash-completed', (data) => received.push(data));

    const sockets = await io.in('orphan-session').fetchSockets();
    syncPendingEvents('orphan-session', sockets[0]);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(received.length).toBe(1);
    expect(received[0].bash.id).toBe('orphan-1');
    expect(received[0].eventId).toBeDefined();

    client.close();
  });

  it('emitTaskEvent should strip type from payload (Socket.IO uses type as event name)', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const receivedPromise = waitForEvent(client, 'subagent-progress');

    emitTaskEvent('session-strip-type', {
      type: 'subagent-progress',
      taskId: 'sp-1',
      messages: [{ type: 'text', text: 'working...' }]
    });

    const received = await receivedPromise;
    // 'type' should NOT be in the payload — it was used as the Socket.IO event name
    expect(received.type).toBeUndefined();
    // But other fields should be there
    expect(received.taskId).toBe('sp-1');
    expect(received.messages).toEqual([{ type: 'text', text: 'working...' }]);
    expect(received.sessionId).toBe('session-strip-type');
    expect(received.eventId).toBeDefined();

    client.close();
  });

  it('each emitTaskEvent call should generate a unique eventId', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const received = [];
    client.on('background-task-started', (data) => received.push(data));

    emitTaskEvent('session-unique-ids', {
      type: 'background-task-started',
      task: { taskId: 'u1' }
    });
    emitTaskEvent('session-unique-ids', {
      type: 'background-task-started',
      task: { taskId: 'u2' }
    });
    emitTaskEvent('session-unique-ids', {
      type: 'background-task-started',
      task: { taskId: 'u3' }
    });

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(received.length).toBe(3);
    const eventIds = received.map(r => r.eventId);
    const uniqueIds = new Set(eventIds);
    expect(uniqueIds.size).toBe(3);

    client.close();
  });

  it('emitTaskEvent should set eventId and sessionId on data', async () => {
    const sessionId = 'session-metadata-test';
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    client.emit('join-session', sessionId);
    await waitForEvent(client, 'joined-session');

    const receivedPromise = waitForEvent(client, 'bash-completed');

    emitTaskEvent(sessionId, {
      type: 'bash-completed',
      bash: { id: 'bash-1', endTime: 123 }
    });

    const received = await receivedPromise;
    expect(received.eventId).toBeDefined();
    expect(typeof received.eventId).toBe('string');
    expect(received.sessionId).toBe(sessionId);
    expect(received.bash.id).toBe('bash-1');

    client.close();
  });
});
