import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';

describe('Socket.IO Server Initialization', () => {
  let httpServer, io, port;

  beforeEach(async () => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;

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

    // Send message to establish offset
    io.emit('test-message', { data: 'test' });
    await waitForEvent(client, 'test-message');

    // Simulate transport-level disconnect by forcefully closing the engine
    const disconnectPromise = new Promise((resolve) => {
      client.on('disconnect', resolve);
    });
    client.io.engine.close();
    await disconnectPromise;

    // Reconnect
    const connectPromise = new Promise((resolve) => {
      client.on('connect', resolve);
    });
    client.connect();
    await connectPromise;

    // Check recovered flag
    expect(client.recovered).toBe(true);

    client.close();
  });
});
