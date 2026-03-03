import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { WebSocketServer, WebSocket } from 'ws';
import { io as ioClient } from 'socket.io-client';
import { createTestClient, waitForEvent } from './helpers/socket-test-utils.js';

describe('Socket.IO and WebSocket Coexistence', () => {
  let httpServer, io, wss, port;

  beforeEach(async () => {
    httpServer = createServer();

    // Socket.IO for /socket.io
    io = new SocketIOServer(httpServer, {
      path: '/socket.io',
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000
      }
    });

    // Raw WebSocket for /shell (noServer mode)
    wss = new WebSocketServer({ noServer: true });

    // Route upgrade requests: Socket.IO auto-handles /socket.io,
    // we only need to handle /shell for raw WS
    httpServer.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url, 'http://localhost').pathname;

      if (pathname === '/shell') {
        wss.handleUpgrade(request, socket, head, (ws) => {
          wss.emit('connection', ws, request);
        });
      }
      // Socket.IO handles /socket.io automatically via its own upgrade listener
    });

    await new Promise((resolve) => {
      httpServer.listen(0, () => {
        port = httpServer.address().port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    io.close();
    wss.close();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  it('should accept Socket.IO connections on /socket.io', async () => {
    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    expect(client.connected).toBe(true);
    client.close();
  });

  it('should accept raw WebSocket connections on /shell', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/shell`);

    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
      setTimeout(() => reject(new Error('Timeout')), 1000);
    });

    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('should handle both connection types simultaneously', async () => {
    const socketIOClient = createTestClient(port);
    const wsClient = new WebSocket(`ws://localhost:${port}/shell`);

    await Promise.all([
      waitForEvent(socketIOClient, 'connect'),
      new Promise((resolve) => wsClient.on('open', resolve))
    ]);

    expect(socketIOClient.connected).toBe(true);
    expect(wsClient.readyState).toBe(WebSocket.OPEN);

    socketIOClient.close();
    wsClient.close();
  });

  it('should route messages independently', async () => {
    let socketIOReceived = false;
    let wsReceived = false;

    // Set up server-side handlers
    io.on('connection', (socket) => {
      socket.on('test-event', () => {
        socketIOReceived = true;
        socket.emit('test-response', { ok: true });
      });
    });

    wss.on('connection', (ws) => {
      ws.on('message', (data) => {
        wsReceived = true;
        ws.send(JSON.stringify({ ok: true }));
      });
    });

    const socketIOClient = createTestClient(port);
    const wsClient = new WebSocket(`ws://localhost:${port}/shell`);

    await Promise.all([
      waitForEvent(socketIOClient, 'connect'),
      new Promise((resolve) => wsClient.on('open', resolve))
    ]);

    // Send messages
    socketIOClient.emit('test-event');
    wsClient.send('test-message');

    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(socketIOReceived).toBe(true);
    expect(wsReceived).toBe(true);

    socketIOClient.close();
    wsClient.close();
  });
});
