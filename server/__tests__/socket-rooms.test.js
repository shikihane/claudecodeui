import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { setupRoomManagement } from '../socket-rooms.js';

describe('Socket.IO Room Management', () => {
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

  it('should join client to session room', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const sessionId = 'test-session-123';
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
    client1.emit('join-session', sessionId);
    client2.emit('join-session', sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    let received1 = false, received2 = false, received3 = false;
    client1.on('room-message', () => { received1 = true; });
    client2.on('room-message', () => { received2 = true; });
    client3.on('room-message', () => { received3 = true; });

    io.to(sessionId).emit('room-message', { data: 'test' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(received1).toBe(true);
    expect(received2).toBe(true);
    expect(received3).toBe(false);

    client1.close();
    client2.close();
    client3.close();
  });

  it('should leave room on disconnect', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const sessionId = 'session-xyz';
    client.emit('join-session', sessionId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const roomsBefore = io.sockets.adapter.rooms.get(sessionId);
    expect(roomsBefore.size).toBe(1);

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const roomsAfter = io.sockets.adapter.rooms.get(sessionId);
    expect(roomsAfter).toBeUndefined();
  });
});
