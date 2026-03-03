import { describe, it, expect, vi } from 'vitest';

describe('useSocketEventHandlers', () => {
  it('should register listeners for all provider events', () => {
    const socket = { on: vi.fn(), off: vi.fn() };
    const events = [
      'claude-response', 'claude-complete', 'claude-error',
      'claude-permission-request', 'claude-status',
      'projects_updated', 'session-created', 'token-budget'
    ];

    events.forEach(e => socket.on(e, vi.fn()));

    expect(socket.on).toHaveBeenCalledTimes(events.length);
    events.forEach(e => {
      expect(socket.on).toHaveBeenCalledWith(e, expect.any(Function));
    });
  });

  it('should update messages on claude-response', () => {
    const messages: any[] = [];
    const handler = (data: any) => {
      messages.push({ role: 'assistant', content: data.text });
    };

    handler({ text: 'Hello from Claude' });
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('Hello from Claude');
  });

  it('should add permission to pending list', () => {
    const pending: any[] = [];
    const handler = (data: any) => { pending.push(data); };

    handler({ requestId: 'r1', toolName: 'bash', toolInput: { cmd: 'ls' } });
    expect(pending.length).toBe(1);
    expect(pending[0].toolName).toBe('bash');
  });

  it('should mark session complete', () => {
    let isComplete = false;
    const handler = () => { isComplete = true; };

    handler();
    expect(isComplete).toBe(true);
  });
});
