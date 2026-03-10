// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';

/**
 * Tests for the background task session filter in useChatRealtimeHandlers.
 * Validates that background task events (bash-completed, subagent-completed)
 * are properly filtered by sessionId in the broadcast-to-all delivery model.
 *
 * The key logic being tested:
 *   isBackgroundTaskForThisSession =
 *     isBackgroundTaskEvent &&
 *     (!msg.sessionId || !activeViewSessionId || msg.sessionId === activeViewSessionId)
 *
 * This prevents events from other sessions leaking into the chat via the
 * shouldBypassSessionFilter shortcut.
 */

describe('Background task session filter (useChatRealtimeHandlers)', () => {
  /**
   * Replicates the session filter logic from useChatRealtimeHandlers.
   * Returns whether the event should bypass the normal session filter.
   */
  function shouldBypassSessionFilter(
    latestMessage: any,
    activeViewSessionId: string | null,
    isGlobalMessage: boolean = false,
    isSystemInitForView: boolean = false,
  ): boolean {
    const isBackgroundTaskEvent =
      (latestMessage.type === 'bash-completed' && latestMessage.background) ||
      latestMessage.type === 'subagent-completed';

    // Background task events bypass the normal session filter but must still
    // match the active session.
    const isBackgroundTaskForThisSession =
      isBackgroundTaskEvent &&
      (!latestMessage.sessionId || !activeViewSessionId || latestMessage.sessionId === activeViewSessionId);

    return isGlobalMessage || isSystemInitForView || isBackgroundTaskForThisSession;
  }

  // =========================================================================
  // bash-completed with background flag
  // =========================================================================
  describe('bash-completed (background)', () => {
    it('should bypass filter when sessionId matches', () => {
      const result = shouldBypassSessionFilter(
        { type: 'bash-completed', background: true, sessionId: 'session-A', bash: { id: 'b1' } },
        'session-A'
      );
      expect(result).toBe(true);
    });

    it('should NOT bypass filter when sessionId does NOT match', () => {
      const result = shouldBypassSessionFilter(
        { type: 'bash-completed', background: true, sessionId: 'session-B', bash: { id: 'b1' } },
        'session-A'
      );
      expect(result).toBe(false);
    });

    it('should bypass filter when event has no sessionId (legacy)', () => {
      const result = shouldBypassSessionFilter(
        { type: 'bash-completed', background: true, bash: { id: 'b1' } },
        'session-A'
      );
      expect(result).toBe(true);
    });

    it('should bypass filter when no active view session', () => {
      const result = shouldBypassSessionFilter(
        { type: 'bash-completed', background: true, sessionId: 'session-B', bash: { id: 'b1' } },
        null
      );
      expect(result).toBe(true);
    });

    it('should NOT bypass for non-background bash-completed', () => {
      // bash-completed without background flag should NOT be treated as bg task
      const result = shouldBypassSessionFilter(
        { type: 'bash-completed', sessionId: 'session-A', bash: { id: 'b1' } },
        'session-A'
      );
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // subagent-completed
  // =========================================================================
  describe('subagent-completed', () => {
    it('should bypass filter when sessionId matches', () => {
      const result = shouldBypassSessionFilter(
        { type: 'subagent-completed', sessionId: 'session-A', taskId: 't1', output: 'done' },
        'session-A'
      );
      expect(result).toBe(true);
    });

    it('should NOT bypass filter when sessionId does NOT match', () => {
      const result = shouldBypassSessionFilter(
        { type: 'subagent-completed', sessionId: 'session-B', taskId: 't1', output: 'done' },
        'session-A'
      );
      expect(result).toBe(false);
    });

    it('should bypass filter when event has no sessionId', () => {
      const result = shouldBypassSessionFilter(
        { type: 'subagent-completed', taskId: 't1', output: 'done' },
        'session-A'
      );
      expect(result).toBe(true);
    });

    it('should bypass filter when no active view session', () => {
      const result = shouldBypassSessionFilter(
        { type: 'subagent-completed', sessionId: 'session-X', taskId: 't1', output: 'done' },
        null
      );
      expect(result).toBe(true);
    });
  });

  // =========================================================================
  // Non-background events should NOT bypass
  // =========================================================================
  describe('non-background events', () => {
    it('should NOT bypass for regular messages', () => {
      const result = shouldBypassSessionFilter(
        { type: 'claude-message', sessionId: 'session-A', content: 'hello' },
        'session-A'
      );
      expect(result).toBe(false);
    });

    it('should NOT bypass for background-task-started', () => {
      const result = shouldBypassSessionFilter(
        { type: 'background-task-started', sessionId: 'session-A', task: {} },
        'session-A'
      );
      expect(result).toBe(false);
    });

    it('should NOT bypass for subagent-progress', () => {
      const result = shouldBypassSessionFilter(
        { type: 'subagent-progress', sessionId: 'session-A', taskId: 't1', messages: [] },
        'session-A'
      );
      expect(result).toBe(false);
    });
  });

  // =========================================================================
  // Global messages and system init always bypass
  // =========================================================================
  describe('global messages and system init', () => {
    it('should bypass for global messages regardless of sessionId', () => {
      const result = shouldBypassSessionFilter(
        { type: 'system-notification', sessionId: 'session-B' },
        'session-A',
        true  // isGlobalMessage
      );
      expect(result).toBe(true);
    });

    it('should bypass for system init regardless of sessionId', () => {
      const result = shouldBypassSessionFilter(
        { type: 'claude-message', sessionId: 'session-B' },
        'session-A',
        false,
        true  // isSystemInitForView
      );
      expect(result).toBe(true);
    });
  });

  // =========================================================================
  // Edge cases
  // =========================================================================
  describe('edge cases', () => {
    it('should handle both sessionId and activeViewSessionId being null', () => {
      const result = shouldBypassSessionFilter(
        { type: 'subagent-completed', taskId: 't1', output: 'done' },
        null
      );
      // No sessionId, no activeViewSessionId → should bypass
      expect(result).toBe(true);
    });

    it('should handle empty string sessionId as falsy', () => {
      const result = shouldBypassSessionFilter(
        { type: 'subagent-completed', sessionId: '', taskId: 't1', output: 'done' },
        'session-A'
      );
      // Empty string is falsy → treated as no sessionId → bypass
      expect(result).toBe(true);
    });

    it('should handle undefined sessionId', () => {
      const result = shouldBypassSessionFilter(
        { type: 'subagent-completed', sessionId: undefined, taskId: 't1' },
        'session-A'
      );
      expect(result).toBe(true);
    });
  });
});
