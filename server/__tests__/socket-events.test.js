import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { setupEventHandlers, MESSAGE_TYPES } from '../socket-events.js';

describe('Socket.IO Event Dispatching', () => {
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

  it('should handle claude-command event', async () => {
    let receivedCommand = null;

    setupEventHandlers(io, {
      onClaudeCommand: (socket, data) => {
        receivedCommand = data;
        socket.emit('claude-response', { status: 'received' });
      }
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    client.emit('claude-command', { prompt: 'test prompt', sessionId: 'abc' });
    const response = await waitForEvent(client, 'claude-response');

    expect(receivedCommand).toEqual({ prompt: 'test prompt', sessionId: 'abc' });
    expect(response.status).toBe('received');

    client.close();
  });

  it('should handle permission-response event', async () => {
    let receivedResponse = null;

    setupEventHandlers(io, {
      onPermissionResponse: (socket, data) => {
        receivedResponse = data;
      }
    });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    client.emit('claude-permission-response', {
      requestId: 'req-123',
      allow: true
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedResponse).toEqual({
      requestId: 'req-123',
      allow: true
    });

    client.close();
  });

  it('should support all message types', () => {
    expect(MESSAGE_TYPES).toHaveProperty('CLAUDE_COMMAND');
    expect(MESSAGE_TYPES).toHaveProperty('CLAUDE_RESPONSE');
    expect(MESSAGE_TYPES).toHaveProperty('CLAUDE_PERMISSION_REQUEST');
    expect(MESSAGE_TYPES).toHaveProperty('CLAUDE_PERMISSION_RESPONSE');
    expect(MESSAGE_TYPES).toHaveProperty('SESSION_CREATED');
    expect(MESSAGE_TYPES).toHaveProperty('PROJECTS_UPDATED');
  });
});
