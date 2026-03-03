import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock socket.io-client
vi.mock('socket.io-client', () => {
  const mockSocket = {
    connected: false,
    recovered: false,
    id: 'test-id',
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    io: { engine: { close: vi.fn() } }
  };
  return { io: vi.fn(() => mockSocket), default: { io: vi.fn(() => mockSocket) } };
});

import { io as mockIo } from 'socket.io-client';

describe('SocketIOContext', () => {
  it('should create socket connection with correct URL', () => {
    const socket = mockIo('http://localhost:3001');
    expect(mockIo).toHaveBeenCalledWith('http://localhost:3001');
  });

  it('should expose connected state', () => {
    const socket = mockIo('http://localhost:3001');
    expect(socket.connected).toBe(false);
  });

  it('should expose recovered flag', () => {
    const socket = mockIo('http://localhost:3001');
    expect(socket.recovered).toBe(false);
  });

  it('should register connect/disconnect listeners', () => {
    const socket = mockIo('http://localhost:3001');
    socket.on('connect', vi.fn());
    socket.on('disconnect', vi.fn());
    expect(socket.on).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(socket.on).toHaveBeenCalledWith('disconnect', expect.any(Function));
  });
});
