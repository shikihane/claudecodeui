import { describe, it, expect } from 'vitest';
import { createSocketWriter } from '../socket-writer.js';

describe('Provider Socket.IO Adaptation', () => {
  it('should create writer with correct interface', () => {
    const mockSocket = { emit: () => {} };
    const writer = createSocketWriter(mockSocket);

    expect(writer).toHaveProperty('send');
    expect(typeof writer.send).toBe('function');
  });

  it('should emit cursor events via writer', () => {
    let emitted = null;
    const mockSocket = { emit: (type, data) => { emitted = { type, data }; } };
    const writer = createSocketWriter(mockSocket);

    writer.send({ type: 'cursor-output', data: { text: 'cursor reply' } });

    expect(emitted.type).toBe('cursor-output');
    expect(emitted.data.data.text).toBe('cursor reply');
  });

  it('should emit codex events via writer', () => {
    let emitted = null;
    const mockSocket = { emit: (type, data) => { emitted = { type, data }; } };
    const writer = createSocketWriter(mockSocket);

    writer.send({ type: 'codex-response', data: { text: 'codex reply' } });

    expect(emitted.type).toBe('codex-response');
  });
});
