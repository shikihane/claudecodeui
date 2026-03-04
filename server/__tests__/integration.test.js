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

  beforeEach(async () => {
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

    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        port = httpServer.address().port;
        resolve();
      });
    });
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
    client.disconnect();
    await new Promise(resolve => setTimeout(resolve, 50)); // Wait for disconnect
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
