import { describe, it, expect } from 'vitest';
import { createSocketWriter } from '../socket-writer.js';

describe('Provider Socket.IO Adaptation', () => {
  it('should create writer with correct interface', () => {
    const mockSocket = { emit: () => {}, connected: true };
    const writer = createSocketWriter(mockSocket);

    expect(writer).toHaveProperty('send');
    expect(typeof writer.send).toBe('function');
    expect(writer.isWebSocketWriter).toBe(true);
  });

  it('should emit cursor events via writer', () => {
    let emitted = null;
    const mockSocket = { emit: (type, data) => { emitted = { type, data }; }, connected: true };
    const writer = createSocketWriter(mockSocket);

    writer.send({ type: 'cursor-output', data: { text: 'cursor reply' } });

    expect(emitted.type).toBe('cursor-output');
    expect(emitted.data.data.text).toBe('cursor reply');
  });

  it('should emit codex events via writer', () => {
    let emitted = null;
    const mockSocket = { emit: (type, data) => { emitted = { type, data }; }, connected: true };
    const writer = createSocketWriter(mockSocket);

    writer.send({ type: 'codex-response', data: { text: 'codex reply' } });

    expect(emitted.type).toBe('codex-response');
  });
});

describe('Resilient Socket Writer - Buffering', () => {
  it('should buffer messages when socket is disconnected', () => {
    const mockSocket = { emit: () => {}, connected: false };
    const writer = createSocketWriter(mockSocket);

    writer.send({ type: 'claude-response', data: { text: 'hello' } });
    writer.send({ type: 'claude-response', data: { text: 'world' } });

    expect(writer.getBufferSize()).toBe(2);
  });

  it('should buffer messages after detach()', () => {
    const mockSocket = { emit: () => {}, connected: true };
    const writer = createSocketWriter(mockSocket);

    writer.detach();
    writer.send({ type: 'claude-response', data: { text: 'buffered' } });

    expect(writer.getBufferSize()).toBe(1);
  });

  it('should not buffer when socket is connected', () => {
    const mockSocket = { emit: () => {}, connected: true };
    const writer = createSocketWriter(mockSocket);

    writer.send({ type: 'claude-response', data: { text: 'direct' } });

    expect(writer.getBufferSize()).toBe(0);
  });

  it('should respect MAX_BUFFER_SIZE limit', () => {
    const mockSocket = { emit: () => {}, connected: false };
    const writer = createSocketWriter(mockSocket);

    for (let i = 0; i < 600; i++) {
      writer.send({ type: 'claude-response', data: { i } });
    }

    expect(writer.getBufferSize()).toBe(500);
  });

  it('should ignore messages with no type', () => {
    const mockSocket = { emit: () => {}, connected: false };
    const writer = createSocketWriter(mockSocket);

    writer.send(null);
    writer.send({});
    writer.send({ data: 'no type' });

    expect(writer.getBufferSize()).toBe(0);
  });
});

describe('Resilient Socket Writer - updateSocket & flush', () => {
  it('should flush buffered messages on updateSocket()', () => {
    const disconnectedSocket = { emit: () => {}, connected: false };
    const writer = createSocketWriter(disconnectedSocket);

    writer.send({ type: 'msg1', data: 'a' });
    writer.send({ type: 'msg2', data: 'b' });
    expect(writer.getBufferSize()).toBe(2);

    const flushed = [];
    const newSocket = {
      emit: (type, data) => { flushed.push({ type, data }); },
      connected: true
    };
    writer.updateSocket(newSocket);

    expect(writer.getBufferSize()).toBe(0);
    expect(flushed).toHaveLength(2);
    expect(flushed[0].type).toBe('msg1');
    expect(flushed[1].type).toBe('msg2');
  });

  it('should not flush if new socket is also disconnected', () => {
    const disconnectedSocket = { emit: () => {}, connected: false };
    const writer = createSocketWriter(disconnectedSocket);

    writer.send({ type: 'msg1', data: 'a' });

    const anotherDisconnected = { emit: () => {}, connected: false };
    writer.updateSocket(anotherDisconnected);

    expect(writer.getBufferSize()).toBe(1);
  });

  it('should send new messages via updated socket after swap', () => {
    const oldSocket = { emit: () => {}, connected: false };
    const writer = createSocketWriter(oldSocket);

    const emitted = [];
    const newSocket = {
      emit: (type, data) => { emitted.push({ type, data }); },
      connected: true
    };
    writer.updateSocket(newSocket);

    writer.send({ type: 'new-msg', data: 'after swap' });

    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('new-msg');
  });

  it('should preserve buffer order during flush', () => {
    const disconnectedSocket = { emit: () => {}, connected: false };
    const writer = createSocketWriter(disconnectedSocket);

    for (let i = 0; i < 5; i++) {
      writer.send({ type: `msg-${i}`, seq: i });
    }

    const flushed = [];
    const newSocket = {
      emit: (type, data) => { flushed.push({ type, seq: data.seq }); },
      connected: true
    };
    writer.updateSocket(newSocket);

    expect(flushed.map(m => m.seq)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('Resilient Socket Writer - sessionId injection', () => {
  it('should inject sessionId into messages when set', () => {
    let emitted = null;
    const mockSocket = { emit: (type, data) => { emitted = data; }, connected: true };
    const writer = createSocketWriter(mockSocket);

    writer.setSessionId('sess-123');
    writer.send({ type: 'claude-response', data: 'test' });

    expect(emitted.sessionId).toBe('sess-123');
  });

  it('should not overwrite existing sessionId in message', () => {
    let emitted = null;
    const mockSocket = { emit: (type, data) => { emitted = data; }, connected: true };
    const writer = createSocketWriter(mockSocket);

    writer.setSessionId('writer-session');
    writer.send({ type: 'claude-response', sessionId: 'msg-session', data: 'test' });

    expect(emitted.sessionId).toBe('msg-session');
  });

  it('should not inject sessionId when not set', () => {
    let emitted = null;
    const mockSocket = { emit: (type, data) => { emitted = data; }, connected: true };
    const writer = createSocketWriter(mockSocket);

    writer.send({ type: 'claude-response', data: 'test' });

    expect(emitted.sessionId).toBeUndefined();
  });

  it('should track sessionId via getSessionId()', () => {
    const mockSocket = { emit: () => {}, connected: true };
    const writer = createSocketWriter(mockSocket);

    expect(writer.getSessionId()).toBeNull();
    writer.setSessionId('abc');
    expect(writer.getSessionId()).toBe('abc');
  });

  it('should inject sessionId into buffered messages too', () => {
    const disconnectedSocket = { emit: () => {}, connected: false };
    const writer = createSocketWriter(disconnectedSocket);

    writer.setSessionId('buffered-sess');
    writer.send({ type: 'claude-response', data: 'buffered' });

    const flushed = [];
    const newSocket = {
      emit: (type, data) => { flushed.push(data); },
      connected: true
    };
    writer.updateSocket(newSocket);

    expect(flushed[0].sessionId).toBe('buffered-sess');
  });
});
