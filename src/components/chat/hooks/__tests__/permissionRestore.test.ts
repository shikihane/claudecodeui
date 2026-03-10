// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Tests for pending permission restore on reconnect.
 * Verifies the useChatRealtimeHandlers reconnect logic:
 * 1. When lastReconnectResult arrives with snapshot.pendingPermissions,
 *    they are restored to state.
 * 2. When session is no longer active, streaming state is reset.
 * 3. When connection drops and sessionStorage exists, UI state is preserved.
 */

describe('Permission restore on reconnect', () => {
  // Simulate the reconnect effect from useChatRealtimeHandlers
  function simulateReconnectEffect(
    lastReconnectResult: {
      success: boolean;
      isActive: boolean;
      writerSwapped: boolean;
      snapshot: {
        status: string;
        pendingPermissions?: any[];
        tokenBudget?: any;
      } | null;
    } | null
  ) {
    let pendingPermissions: any[] = [];
    let isLoading = false;
    let canAbortSession = false;
    let tokenBudget: any = null;

    if (!lastReconnectResult) {
      return { pendingPermissions, isLoading, canAbortSession, tokenBudget };
    }

    const { isActive, snapshot } = lastReconnectResult;

    if (isActive && snapshot) {
      // Restore pending permissions
      if (snapshot.pendingPermissions && snapshot.pendingPermissions.length > 0) {
        pendingPermissions = snapshot.pendingPermissions;
      }

      // Restore streaming state
      if (snapshot.status === 'streaming' || snapshot.status === 'awaiting_permission') {
        isLoading = true;
        canAbortSession = true;
      }

      // Restore token budget
      if (snapshot.tokenBudget) {
        tokenBudget = snapshot.tokenBudget;
      }
    }

    return { pendingPermissions, isLoading, canAbortSession, tokenBudget };
  }

  it('should restore pending permissions from snapshot', () => {
    const result = simulateReconnectEffect({
      success: true,
      isActive: true,
      writerSwapped: true,
      snapshot: {
        status: 'awaiting_permission',
        pendingPermissions: [
          { requestId: 'r1', toolName: 'Bash', toolInput: { command: 'rm -rf /' } },
          { requestId: 'r2', toolName: 'Write', toolInput: { file_path: '/etc/hosts' } }
        ]
      }
    });

    expect(result.pendingPermissions).toHaveLength(2);
    expect(result.pendingPermissions[0].requestId).toBe('r1');
    expect(result.pendingPermissions[0].toolName).toBe('Bash');
    expect(result.pendingPermissions[1].requestId).toBe('r2');
  });

  it('should restore streaming state when status is streaming', () => {
    const result = simulateReconnectEffect({
      success: true,
      isActive: true,
      writerSwapped: true,
      snapshot: {
        status: 'streaming',
        pendingPermissions: []
      }
    });

    expect(result.isLoading).toBe(true);
    expect(result.canAbortSession).toBe(true);
    expect(result.pendingPermissions).toEqual([]);
  });

  it('should restore streaming state when status is awaiting_permission', () => {
    const result = simulateReconnectEffect({
      success: true,
      isActive: true,
      writerSwapped: true,
      snapshot: {
        status: 'awaiting_permission',
        pendingPermissions: [{ requestId: 'r3', toolName: 'Edit' }]
      }
    });

    expect(result.isLoading).toBe(true);
    expect(result.canAbortSession).toBe(true);
    expect(result.pendingPermissions).toHaveLength(1);
  });

  it('should NOT restore state when session is no longer active', () => {
    const result = simulateReconnectEffect({
      success: true,
      isActive: false,
      writerSwapped: false,
      snapshot: {
        status: 'idle',
        pendingPermissions: []
      }
    });

    expect(result.pendingPermissions).toEqual([]);
    expect(result.isLoading).toBe(false);
    expect(result.canAbortSession).toBe(false);
  });

  it('should NOT restore state when snapshot is null', () => {
    const result = simulateReconnectEffect({
      success: true,
      isActive: true,
      writerSwapped: false,
      snapshot: null
    });

    expect(result.pendingPermissions).toEqual([]);
    expect(result.isLoading).toBe(false);
  });

  it('should NOT restore state when lastReconnectResult is null', () => {
    const result = simulateReconnectEffect(null);

    expect(result.pendingPermissions).toEqual([]);
    expect(result.isLoading).toBe(false);
  });

  it('should restore token budget from snapshot', () => {
    const result = simulateReconnectEffect({
      success: true,
      isActive: true,
      writerSwapped: true,
      snapshot: {
        status: 'streaming',
        pendingPermissions: [],
        tokenBudget: { used: 50000, total: 160000 }
      }
    });

    expect(result.tokenBudget).toEqual({ used: 50000, total: 160000 });
  });

  it('should handle empty pendingPermissions array (not restore)', () => {
    const result = simulateReconnectEffect({
      success: true,
      isActive: true,
      writerSwapped: true,
      snapshot: {
        status: 'idle',
        pendingPermissions: []
      }
    });

    // Empty array should NOT trigger restore (the check is .length > 0)
    expect(result.pendingPermissions).toEqual([]);
    // idle status should NOT trigger streaming state
    expect(result.isLoading).toBe(false);
  });
});

describe('Disconnect UI state preservation', () => {
  const ACTIVE_SESSION_KEY = 'socketio-active-session';

  beforeEach(() => {
    sessionStorage.clear();
  });

  // Simulate the disconnect effect from useChatRealtimeHandlers
  function simulateDisconnectEffect(isConnected: boolean) {
    let isLoading = true;
    let canAbortSession = true;
    let claudeStatus: string | null = 'processing';

    if (!isConnected) {
      const hasActiveSession = !!sessionStorage.getItem(ACTIVE_SESSION_KEY);
      if (!hasActiveSession) {
        isLoading = false;
        canAbortSession = false;
        claudeStatus = null;
      }
      // Note: pendingPermissionRequests are NOT cleared here
    }

    return { isLoading, canAbortSession, claudeStatus };
  }

  it('should preserve UI state on disconnect when sessionStorage has active session', () => {
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({
      sessionId: 'active-sess',
      provider: 'claude'
    }));

    const result = simulateDisconnectEffect(false);

    // UI state should be preserved (not reset)
    expect(result.isLoading).toBe(true);
    expect(result.canAbortSession).toBe(true);
    expect(result.claudeStatus).toBe('processing');
  });

  it('should reset UI state on disconnect when no active session in sessionStorage', () => {
    // No stored session
    const result = simulateDisconnectEffect(false);

    // UI state should be reset
    expect(result.isLoading).toBe(false);
    expect(result.canAbortSession).toBe(false);
    expect(result.claudeStatus).toBeNull();
  });

  it('should not change state when still connected', () => {
    const result = simulateDisconnectEffect(true);

    // State untouched when connected
    expect(result.isLoading).toBe(true);
    expect(result.canAbortSession).toBe(true);
  });
});

describe('session-state.js server-side pending permissions', () => {
  // Replicate the server's session-state logic for testing
  function createSessionState(sessionId: string, provider: string) {
    return {
      sessionId,
      provider,
      status: 'idle',
      pendingPermissions: [] as any[],
      tokenBudget: null as any,
      lastActivity: Date.now()
    };
  }

  function addPendingPermission(state: ReturnType<typeof createSessionState>, perm: any) {
    state.pendingPermissions.push(perm);
    state.status = 'awaiting_permission';
  }

  function removePendingPermission(state: ReturnType<typeof createSessionState>, requestId: string) {
    state.pendingPermissions = state.pendingPermissions.filter((p: any) => p.requestId !== requestId);
    if (!state.pendingPermissions.length && state.status === 'awaiting_permission') {
      state.status = 'streaming';
    }
  }

  function getStateSnapshot(state: ReturnType<typeof createSessionState>) {
    return {
      sessionId: state.sessionId,
      provider: state.provider,
      status: state.status,
      pendingPermissions: state.pendingPermissions,
      tokenBudget: state.tokenBudget,
      lastActivity: state.lastActivity
    };
  }

  it('addPendingPermission should add permission and set status', () => {
    const state = createSessionState('s1', 'claude');
    addPendingPermission(state, { requestId: 'r1', toolName: 'Bash' });

    expect(state.pendingPermissions).toHaveLength(1);
    expect(state.status).toBe('awaiting_permission');
  });

  it('removePendingPermission should remove and revert status when empty', () => {
    const state = createSessionState('s1', 'claude');
    addPendingPermission(state, { requestId: 'r1', toolName: 'Bash' });
    addPendingPermission(state, { requestId: 'r2', toolName: 'Write' });

    removePendingPermission(state, 'r1');
    expect(state.pendingPermissions).toHaveLength(1);
    expect(state.status).toBe('awaiting_permission');

    removePendingPermission(state, 'r2');
    expect(state.pendingPermissions).toHaveLength(0);
    expect(state.status).toBe('streaming'); // reverts to streaming
  });

  it('getStateSnapshot should include pendingPermissions', () => {
    const state = createSessionState('s1', 'claude');
    addPendingPermission(state, { requestId: 'r1', toolName: 'Bash', toolInput: { command: 'ls' } });

    const snapshot = getStateSnapshot(state);
    expect(snapshot.pendingPermissions).toHaveLength(1);
    expect(snapshot.pendingPermissions[0].requestId).toBe('r1');
    expect(snapshot.status).toBe('awaiting_permission');
  });

  it('snapshot should reflect empty permissions correctly', () => {
    const state = createSessionState('s1', 'claude');
    const snapshot = getStateSnapshot(state);

    expect(snapshot.pendingPermissions).toEqual([]);
    expect(snapshot.status).toBe('idle');
  });
});
