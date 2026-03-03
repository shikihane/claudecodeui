import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import {
  createSessionState, deleteSessionState, addStreamingChunk,
  addPendingPermission, updateSessionState, getStateSnapshot
} from '../session-state.js';

describe('State Snapshot API', () => {
  let httpServer, io, port;
  const sid = 'snap-session';

  beforeEach(async () => {
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
