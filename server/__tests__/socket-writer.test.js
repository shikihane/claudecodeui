import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { createSocketWriter, createBroadcastWriter } from '../socket-writer.js';

describe('Socket.IO Writer Adapter', () => {
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
