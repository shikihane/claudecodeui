import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createSessionState, getSessionState, deleteSessionState,
  updateSessionState, addStreamingChunk, finalizeStreamingMessage,
  addPendingPermission, removePendingPermission
} from '../session-state.js';

describe('Session State Management', () => {
  const sid = 'test-session';
  beforeEach(() => { deleteSessionState(sid); });
  afterEach(() => { deleteSessionState(sid); });

  it('should create session state', () => {
    const s = createSessionState(sid, 'claude');
    expect(s.status).toBe('idle');
    expect(s.messages).toEqual([]);
  });

  it('should accumulate streaming chunks', () => {
    createSessionState(sid, 'claude');
    addStreamingChunk(sid, 'Hello ');
    addStreamingChunk(sid, 'world');
    expect(getSessionState(sid).currentStreamingText).toBe('Hello world');
  });

  it('should finalize streaming message', () => {
    createSessionState(sid, 'claude');
    addStreamingChunk(sid, 'Done');
    finalizeStreamingMessage(sid);
    const s = getSessionState(sid);
    expect(s.currentStreamingText).toBe('');
    expect(s.messages[0].content).toBe('Done');
  });

  it('should manage pending permissions', () => {
    createSessionState(sid, 'claude');
    addPendingPermission(sid, { requestId: 'r1', toolName: 'bash' });
    expect(getSessionState(sid).pendingPermissions.length).toBe(1);
    removePendingPermission(sid, 'r1');
    expect(getSessionState(sid).pendingPermissions.length).toBe(0);
  });

  it('should return null for missing session', () => {
    expect(getSessionState('no-exist')).toBeNull();
  });
});
