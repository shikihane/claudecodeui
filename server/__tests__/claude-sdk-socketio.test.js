import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createSessionState, getSessionState, deleteSessionState,
  addStreamingChunk, finalizeStreamingMessage,
  addPendingPermission, removePendingPermission
} from '../session-state.js';

describe('Claude SDK Session State Integration', () => {
  const sid = 'claude-session';
  beforeEach(() => { deleteSessionState(sid); });
  afterEach(() => { deleteSessionState(sid); });

  it('should accumulate streaming chunks in session state', () => {
    createSessionState(sid, 'claude');
    // Simulate SDK streaming
    addStreamingChunk(sid, 'Hello ');
    addStreamingChunk(sid, 'from ');
    addStreamingChunk(sid, 'Claude');

    const state = getSessionState(sid);
    expect(state.currentStreamingText).toBe('Hello from Claude');
  });

  it('should finalize message on content_block_stop', () => {
    createSessionState(sid, 'claude');
    addStreamingChunk(sid, 'Complete response');
    finalizeStreamingMessage(sid);

    const state = getSessionState(sid);
    expect(state.currentStreamingText).toBe('');
    expect(state.messages[0].content).toBe('Complete response');
  });

  it('should store tool approval in session state', () => {
    createSessionState(sid, 'claude');
    addPendingPermission(sid, {
      requestId: 'tool-1',
      toolName: 'Write',
      toolInput: { path: '/tmp/test.txt' }
    });

    const state = getSessionState(sid);
    expect(state.status).toBe('awaiting_permission');
    expect(state.pendingPermissions[0].toolName).toBe('Write');
  });

  it('should remove permission after approval', () => {
    createSessionState(sid, 'claude');
    addPendingPermission(sid, { requestId: 'tool-1', toolName: 'Write' });
    removePendingPermission(sid, 'tool-1');

    const state = getSessionState(sid);
    expect(state.pendingPermissions.length).toBe(0);
  });
});
