import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { broadcastToAll, broadcastToSession } from '../socket-rooms.js';

describe('Broadcasting Migration', () => {
  let httpServer, io, port;

  beforeEach(async () => {
    const setup = createTestServer();
    httpServer = setup.httpServer;
    io = setup.io;
    await new Promise((resolve) => {
      httpServer.listen(0, () => { port = httpServer.address().port; resolve(); });
    });
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
    // Register join handler before clients connect
    io.on('connection', (socket) => {
      socket.on('join-session', (sid) => {
        socket.join(sid);
        socket.emit('joined-session', sid);
      });
    });

    const c1 = createTestClient(port);
    const c2 = createTestClient(port);

    await Promise.all([waitForEvent(c1, 'connect'), waitForEvent(c2, 'connect')]);

    c1.emit('join-session', 'session-A');
    await waitForEvent(c1, 'joined-session');

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
