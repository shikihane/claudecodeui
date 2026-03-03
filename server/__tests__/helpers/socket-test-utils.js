import { createServer } from 'http';
import { Server } from 'socket.io';
import { io as ioClient } from 'socket.io-client';

export function createTestServer(options = {}) {
  const httpServer = createServer();
  const io = new Server(httpServer, {
    connectionStateRecovery: {
      maxDisconnectionDuration: 2 * 60 * 1000
    },
    ...options
  });

  return { httpServer, io };
}

export function createTestClient(port, options = {}) {
  return ioClient(`http://localhost:${port}`, {
    reconnection: true,
    reconnectionDelay: 100,
    ...options
  });
}

export function waitForEvent(socket, eventName, timeout = 1000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${eventName}`));
    }, timeout);

    socket.once(eventName, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

export async function cleanupTestServer(httpServer, io) {
  io.close();
  await new Promise((resolve) => httpServer.close(resolve));
}
