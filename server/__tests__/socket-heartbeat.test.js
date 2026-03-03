import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, createTestClient, waitForEvent, cleanupTestServer } from './helpers/socket-test-utils.js';
import { setupHeartbeat } from '../socket-heartbeat.js';

describe('Application-level Heartbeat', () => {
  let httpServer, io, port;
  let cleanupHeartbeat;

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
    if (cleanupHeartbeat) cleanupHeartbeat();
    await cleanupTestServer(httpServer, io);
  });

  it('should send heartbeat at configured interval', async () => {
    cleanupHeartbeat = setupHeartbeat(io, { intervalMs: 100 });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const hb1 = await waitForEvent(client, 'heartbeat', 500);
    expect(hb1).toHaveProperty('seq');

    client.close();
  });

  it('should increment seq monotonically', async () => {
    cleanupHeartbeat = setupHeartbeat(io, { intervalMs: 50 });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const hb1 = await waitForEvent(client, 'heartbeat', 500);
    const hb2 = await waitForEvent(client, 'heartbeat', 500);

    expect(hb2.seq).toBeGreaterThan(hb1.seq);

    client.close();
  });

  it('should include server timestamp', async () => {
    cleanupHeartbeat = setupHeartbeat(io, { intervalMs: 100 });

    const client = createTestClient(port);
    await waitForEvent(client, 'connect');

    const hb = await waitForEvent(client, 'heartbeat', 500);
    expect(hb).toHaveProperty('ts');
    expect(typeof hb.ts).toBe('number');

    client.close();
  });
});
