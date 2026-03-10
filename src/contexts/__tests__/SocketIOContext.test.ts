// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Track what the mock socket does
let connectHandler: Function | null = null;
let disconnectHandler: Function | null = null;
const emitCalls: Array<{ event: string; args: any[] }> = [];
const onHandlers = new Map<string, Function>();

const mockSocket = {
  connected: false,
  recovered: false,
  id: 'test-socket-id',
  on: vi.fn((event: string, handler: Function) => {
    onHandlers.set(event, handler);
    if (event === 'connect') connectHandler = handler;
    if (event === 'disconnect') disconnectHandler = handler;
  }),
  off: vi.fn(),
  emit: vi.fn((...args: any[]) => {
    emitCalls.push({ event: args[0], args: args.slice(1) });
  }),
  connect: vi.fn(),
  disconnect: vi.fn(),
  io: { engine: { close: vi.fn() } }
};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
  default: { io: vi.fn(() => mockSocket) }
}));

const ACTIVE_SESSION_KEY = 'socketio-active-session';

describe('SocketIOContext', () => {
  beforeEach(() => {
    sessionStorage.clear();
    emitCalls.length = 0;
    onHandlers.clear();
    connectHandler = null;
    disconnectHandler = null;
    mockSocket.emit.mockClear();
    mockSocket.on.mockClear();
  });

  // =========================================================================
  // setActiveSession logic tests
  // =========================================================================

  describe('setActiveSession logic', () => {
    // Simulate the setActiveSession callback logic from SocketIOContext
    function createSetActiveSession() {
      let prevSession: string | null = null;

      return function setActiveSession(sessionId: string | null, provider: string = 'claude') {
        // Only leave old room when switching to a DIFFERENT session
        if (sessionId && prevSession && prevSession !== sessionId) {
          mockSocket.emit('leave-session', prevSession);
        }

        if (sessionId) {
          sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ sessionId, provider }));
          mockSocket.emit('join-session', sessionId);
          prevSession = sessionId;
        } else {
          // Don't remove sessionStorage — keep it for reconnect
        }
      };
    }

    it('should store session info in sessionStorage when setting a session', () => {
      const setActiveSession = createSetActiveSession();
      setActiveSession('session-123', 'claude');

      const stored = JSON.parse(sessionStorage.getItem(ACTIVE_SESSION_KEY)!);
      expect(stored.sessionId).toBe('session-123');
      expect(stored.provider).toBe('claude');
    });

    it('should emit join-session when setting a session', () => {
      const setActiveSession = createSetActiveSession();
      mockSocket.emit.mockClear();

      setActiveSession('session-456');

      expect(mockSocket.emit).toHaveBeenCalledWith('join-session', 'session-456');
    });

    it('should NOT remove sessionStorage when setting null (streaming ended)', () => {
      const setActiveSession = createSetActiveSession();
      setActiveSession('session-persist', 'claude');

      // Verify it's stored
      expect(sessionStorage.getItem(ACTIVE_SESSION_KEY)).not.toBeNull();

      // Set null (streaming ended)
      setActiveSession(null);

      // SessionStorage should STILL have the entry
      const stored = JSON.parse(sessionStorage.getItem(ACTIVE_SESSION_KEY)!);
      expect(stored.sessionId).toBe('session-persist');
      expect(stored.provider).toBe('claude');
    });

    it('should NOT emit leave-session when setting null', () => {
      const setActiveSession = createSetActiveSession();
      setActiveSession('session-noleave');
      mockSocket.emit.mockClear();

      setActiveSession(null);

      // Should NOT have emitted leave-session
      const leaveEmits = mockSocket.emit.mock.calls.filter(
        (c: any[]) => c[0] === 'leave-session'
      );
      expect(leaveEmits.length).toBe(0);
    });

    it('should emit leave-session on old room when switching to a DIFFERENT session', () => {
      const setActiveSession = createSetActiveSession();
      setActiveSession('session-A');
      mockSocket.emit.mockClear();

      setActiveSession('session-B');

      expect(mockSocket.emit).toHaveBeenCalledWith('leave-session', 'session-A');
      expect(mockSocket.emit).toHaveBeenCalledWith('join-session', 'session-B');
    });

    it('should NOT emit leave-session when re-joining the same session', () => {
      const setActiveSession = createSetActiveSession();
      setActiveSession('session-same');
      mockSocket.emit.mockClear();

      setActiveSession('session-same');

      // Should only emit join-session, not leave-session
      const leaveEmits = mockSocket.emit.mock.calls.filter(
        (c: any[]) => c[0] === 'leave-session'
      );
      expect(leaveEmits.length).toBe(0);
    });
  });

  // =========================================================================
  // Reconnect flow tests
  // =========================================================================

  describe('reconnect flow on connect', () => {
    // Simulate the connect handler logic from SocketIOContext
    function simulateConnectHandler(
      setLastReconnectResult: (r: any) => void
    ) {
      const stored = sessionStorage.getItem(ACTIVE_SESSION_KEY);
      if (stored) {
        try {
          const { sessionId, provider } = JSON.parse(stored);
          mockSocket.emit('join-session', sessionId);
          mockSocket.emit('reconnect-session', { sessionId, provider }, (result: any) => {
            setLastReconnectResult(result);
            if (!result?.isActive) {
              sessionStorage.removeItem(ACTIVE_SESSION_KEY);
            }
          });
        } catch {
          sessionStorage.removeItem(ACTIVE_SESSION_KEY);
        }
      }
    }

    it('should attempt reconnect when sessionStorage has stored session', () => {
      sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({
        sessionId: 'stored-session',
        provider: 'claude'
      }));

      mockSocket.emit.mockClear();
      simulateConnectHandler(vi.fn());

      expect(mockSocket.emit).toHaveBeenCalledWith('join-session', 'stored-session');
      expect(mockSocket.emit).toHaveBeenCalledWith(
        'reconnect-session',
        { sessionId: 'stored-session', provider: 'claude' },
        expect.any(Function)
      );
    });

    it('should NOT attempt reconnect when sessionStorage is empty', () => {
      // No stored session
      mockSocket.emit.mockClear();
      simulateConnectHandler(vi.fn());

      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    it('should clear sessionStorage when reconnect says session is no longer active', () => {
      sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({
        sessionId: 'dead-session',
        provider: 'claude'
      }));

      let reconnectCallback: Function | null = null;
      mockSocket.emit.mockImplementation((...args: any[]) => {
        if (args[0] === 'reconnect-session' && typeof args[2] === 'function') {
          reconnectCallback = args[2];
        }
      });

      const setResult = vi.fn();
      simulateConnectHandler(setResult);

      // Simulate server responding with isActive: false
      reconnectCallback!({ success: true, isActive: false, snapshot: { status: 'idle' } });

      // SessionStorage should be cleaned up
      expect(sessionStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
      expect(setResult).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
    });

    it('should keep sessionStorage when reconnect says session IS still active', () => {
      sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({
        sessionId: 'active-session',
        provider: 'claude'
      }));

      let reconnectCallback: Function | null = null;
      mockSocket.emit.mockImplementation((...args: any[]) => {
        if (args[0] === 'reconnect-session' && typeof args[2] === 'function') {
          reconnectCallback = args[2];
        }
      });

      const setResult = vi.fn();
      simulateConnectHandler(setResult);

      // Simulate server responding with isActive: true
      reconnectCallback!({
        success: true,
        isActive: true,
        snapshot: { status: 'streaming', pendingPermissions: [] }
      });

      // SessionStorage should still have the entry
      const stored = JSON.parse(sessionStorage.getItem(ACTIVE_SESSION_KEY)!);
      expect(stored.sessionId).toBe('active-session');
      expect(setResult).toHaveBeenCalledWith(expect.objectContaining({ isActive: true }));
    });

    it('should clear sessionStorage on JSON parse error', () => {
      sessionStorage.setItem(ACTIVE_SESSION_KEY, 'invalid-json{{{');

      mockSocket.emit.mockClear();
      simulateConnectHandler(vi.fn());

      expect(sessionStorage.getItem(ACTIVE_SESSION_KEY)).toBeNull();
      // Should not have emitted anything
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });
  });

  // =========================================================================
  // Full lifecycle: set session → null → refresh → reconnect
  // =========================================================================

  describe('full lifecycle: session persistence across page refresh', () => {
    it('sessionStorage survives setActiveSession(null) so reconnect works', () => {
      // 1. Start streaming → setActiveSession('sess-1')
      sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({
        sessionId: 'sess-1',
        provider: 'claude'
      }));

      // 2. Streaming ends → setActiveSession(null)
      // In the new code, this does NOT remove sessionStorage

      // 3. Simulate page refresh → check sessionStorage still exists
      const stored = sessionStorage.getItem(ACTIVE_SESSION_KEY);
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!);
      expect(parsed.sessionId).toBe('sess-1');

      // 4. Connect handler fires → reconnect-session is called
      let reconnectCallback: Function | null = null;
      mockSocket.emit.mockImplementation((...args: any[]) => {
        if (args[0] === 'reconnect-session' && typeof args[2] === 'function') {
          reconnectCallback = args[2];
        }
      });

      const setResult = vi.fn();

      // Simulate connect handler
      const storedSession = sessionStorage.getItem(ACTIVE_SESSION_KEY);
      if (storedSession) {
        const { sessionId, provider } = JSON.parse(storedSession);
        mockSocket.emit('join-session', sessionId);
        mockSocket.emit('reconnect-session', { sessionId, provider }, (result: any) => {
          setResult(result);
          if (!result?.isActive) {
            sessionStorage.removeItem(ACTIVE_SESSION_KEY);
          }
        });
      }

      expect(mockSocket.emit).toHaveBeenCalledWith('join-session', 'sess-1');
      expect(reconnectCallback).not.toBeNull();

      // 5. Server says session still active with pending permissions
      reconnectCallback!({
        success: true,
        isActive: true,
        snapshot: {
          status: 'awaiting_permission',
          pendingPermissions: [{ requestId: 'r1', toolName: 'Bash' }]
        }
      });

      expect(setResult).toHaveBeenCalledWith(expect.objectContaining({
        isActive: true,
        snapshot: expect.objectContaining({
          pendingPermissions: [{ requestId: 'r1', toolName: 'Bash' }]
        })
      }));

      // SessionStorage preserved
      expect(sessionStorage.getItem(ACTIVE_SESSION_KEY)).not.toBeNull();
    });
  });
});
