# Socket.IO Session Reconnect Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** When a user refreshes the browser mid-conversation, the new Socket.IO connection seamlessly reconnects to the active Claude SDK session, replays buffered messages, and restores full streaming state.

**Architecture:** The server-side socket-writer becomes a "resilient writer" that buffers messages when no socket is connected and flushes them on reconnect. The frontend persists the active sessionId in sessionStorage, and on connect emits `reconnect-session` so the server can swap the writer's underlying socket reference and replay buffered data. The server also sends a state snapshot (pending permissions, streaming status) so the frontend UI is fully restored.

**Tech Stack:** Socket.IO (server + client), sessionStorage (frontend persistence), existing session-state.js (server state tracking)

---

## Architecture Overview

```
BEFORE (broken):
  writer ──bind──► old socket ──X──► (dead after refresh)
  new socket ──► (orphaned, no data flowing)

AFTER (fixed):
  writer ──bind──► socketRef (mutable) ──► current socket
                   ↓ (if disconnected)
                   buffer[] accumulates messages
                   ↓ (on reconnect)
                   flush buffer → new socket
                   socketRef = new socket
```

Key design: The writer never breaks. It buffers when disconnected. The server swaps the socket ref on reconnect. The frontend triggers reconnect via `reconnect-session` event.

---

### Task 1: Make socket-writer resilient (buffering + socket swap)

**Files:**
- Modify: `server/socket-writer.js`

**Step 1: Rewrite createSocketWriter with buffer and swap support**

Replace the entire `createSocketWriter` function. The new version:
- Holds a mutable `socketRef` instead of a closed-over socket
- Buffers messages when socket is null/disconnected
- Provides `updateSocket(newSocket)` to hot-swap and flush
- Provides `setSessionId(id)` for session tracking
- Provides `detach()` to null out the socket (on disconnect)

```js
export function createSocketWriter(socket) {
  let socketRef = socket;
  let sessionId = null;
  const buffer = [];
  const MAX_BUFFER_SIZE = 500;

  function flush() {
    if (!socketRef || !socketRef.connected) return;
    while (buffer.length > 0) {
      const { type, rest } = buffer.shift();
      socketRef.emit(type, rest);
    }
  }

  const writer = {
    isWebSocketWriter: true,

    send(msg) {
      if (!msg || !msg.type) return;
      const { type, ...rest } = msg;
      if (sessionId) rest.sessionId = rest.sessionId || sessionId;

      if (socketRef && socketRef.connected) {
        socketRef.emit(type, rest);
      } else {
        if (buffer.length < MAX_BUFFER_SIZE) {
          buffer.push({ type, rest });
        }
      }
    },

    updateSocket(newSocket) {
      socketRef = newSocket;
      flush();
    },

    detach() {
      socketRef = null;
    },

    setSessionId(id) {
      sessionId = id;
    },

    getSessionId() {
      return sessionId;
    },

    getBufferSize() {
      return buffer.length;
    }
  };

  return writer;
}
```

Leave `createBroadcastWriter` unchanged.

**Step 2: Verify no tests break**

Run: `npx vitest run --reporter=verbose 2>&1 | head -50`
Expected: All existing tests pass (socket-writer tests may need updating if they exist)

**Step 3: Commit**

```bash
git add server/socket-writer.js
git commit -m "feat: make socket-writer resilient with buffering and socket swap"
```

---

### Task 2: Server handles reconnect-session event

**Files:**
- Modify: `server/index.js` (inside `io.on('connection', ...)` block, around line 364-462)
- Modify: `server/claude-sdk.js` (fix `reconnectSessionWriter` to use new writer API)

**Step 1: Add `reconnect-session` handler in server/index.js**

Inside the `io.on('connection', (socket) => { ... })` block, after the existing `request-state-snapshot` handler (line 372), add:

```js
  // Session reconnection (browser refresh while streaming)
  socket.on('reconnect-session', (data, ack) => {
    const { sessionId, provider } = data || {};
    if (!sessionId) {
      if (typeof ack === 'function') ack({ success: false, reason: 'no sessionId' });
      return;
    }

    console.log(`[Socket.IO] reconnect-session: ${sessionId} from socket ${socket.id}`);

    // Join the session room
    socket.join(sessionId);

    // Try to swap the writer for active Claude sessions
    let writerSwapped = false;
    if (!provider || provider === 'claude') {
      writerSwapped = reconnectSessionWriter(sessionId, socket);
    }

    // Get current state snapshot
    const snapshot = getStateSnapshot(sessionId);

    // Check if session is still active
    let isActive = false;
    if (provider === 'cursor') {
      isActive = isCursorSessionActive(sessionId);
    } else if (provider === 'codex') {
      isActive = isCodexSessionActive(sessionId);
    } else {
      isActive = isClaudeSDKSessionActive(sessionId);
    }

    const result = {
      success: true,
      writerSwapped,
      isActive,
      snapshot
    };

    console.log(`[Socket.IO] reconnect-session result:`, {
      sessionId,
      writerSwapped,
      isActive,
      status: snapshot.status,
      pendingPermissions: snapshot.pendingPermissions?.length || 0,
      bufferedMessages: 'flushed via writer'
    });

    if (typeof ack === 'function') ack(result);
  });
```

**Step 2: Fix `reconnectSessionWriter` in server/claude-sdk.js**

The existing function calls `writer.updateWebSocket()` which doesn't exist. Fix it to call `writer.updateSocket()` which matches our new writer API:

Change `server/claude-sdk.js` line 1480-1486 from:
```js
function reconnectSessionWriter(sessionId, newRawWs) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateWebSocket) return false;
  session.writer.updateWebSocket(newRawWs);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}`);
  return true;
}
```

To:
```js
function reconnectSessionWriter(sessionId, newSocket) {
  const session = getSession(sessionId);
  if (!session?.writer?.updateSocket) return false;
  session.writer.updateSocket(newSocket);
  console.log(`[RECONNECT] Writer swapped for session ${sessionId}, buffer flushed`);
  return true;
}
```

**Step 3: Wire up writer detach on socket disconnect**

In the existing `socket.on('disconnect', ...)` handler in `server/index.js` (line 459-461), we need to detach writers that were bound to this socket. But we don't track which sessions belong to which socket directly. Instead, handle this in the writer itself — when `socket.connected` is false, `send()` already buffers. No change needed here; the writer's `socketRef.connected` check handles it naturally.

**Step 4: Commit**

```bash
git add server/index.js server/claude-sdk.js
git commit -m "feat: add reconnect-session handler with writer swap and state snapshot"
```

---

### Task 3: Frontend persists sessionId and sends reconnect-session on connect

**Files:**
- Modify: `src/contexts/SocketIOContext.tsx`
- Modify: `src/components/chat/hooks/useChatRealtimeHandlers.ts`

**Step 1: Add session persistence and reconnect logic to SocketIOContext**

The context needs to:
1. Store the active sessionId so it can be sent on reconnect
2. On `connect`, check sessionStorage for an active session and emit `reconnect-session`
3. Expose a `setActiveSession` function for the chat hooks to call

Replace `src/contexts/SocketIOContext.tsx` with:

```tsx
import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';

const ACTIVE_SESSION_KEY = 'socketio-active-session';

interface ActiveSessionInfo {
  sessionId: string;
  provider: string;
}

interface ReconnectResult {
  success: boolean;
  writerSwapped: boolean;
  isActive: boolean;
  snapshot: any;
}

interface SocketIOContextType {
  socket: Socket | null;
  isConnected: boolean;
  recovered: boolean;
  emit: (eventOrMessage: string | Record<string, any>, ...args: any[]) => void;
  setActiveSession: (sessionId: string | null, provider?: string) => void;
  lastReconnectResult: ReconnectResult | null;
}

const SocketIOContext = createContext<SocketIOContextType>({
  socket: null,
  isConnected: false,
  recovered: false,
  emit: () => {},
  setActiveSession: () => {},
  lastReconnectResult: null
});

export function SocketIOProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [lastReconnectResult, setLastReconnectResult] = useState<ReconnectResult | null>(null);

  const setActiveSession = useCallback((sessionId: string | null, provider: string = 'claude') => {
    if (sessionId) {
      sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ sessionId, provider }));
    } else {
      sessionStorage.removeItem(ACTIVE_SESSION_KEY);
    }
  }, []);

  useEffect(() => {
    if (!token) return;

    const socket = io(window.location.origin, {
      path: '/socket.io',
      auth: { token },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });

    socket.on('connect', () => {
      setIsConnected(true);
      setRecovered(socket.recovered);

      // Attempt session reconnection
      const stored = sessionStorage.getItem(ACTIVE_SESSION_KEY);
      if (stored) {
        try {
          const { sessionId, provider } = JSON.parse(stored) as ActiveSessionInfo;
          console.log('[SocketIO] Attempting session reconnect:', sessionId);
          socket.emit('reconnect-session', { sessionId, provider }, (result: ReconnectResult) => {
            console.log('[SocketIO] Reconnect result:', result);
            setLastReconnectResult(result);
            if (!result?.isActive) {
              // Session no longer active, clean up
              sessionStorage.removeItem(ACTIVE_SESSION_KEY);
            }
          });
        } catch {
          sessionStorage.removeItem(ACTIVE_SESSION_KEY);
        }
      }
    });

    socket.on('disconnect', () => {
      setIsConnected(false);
      setRecovered(false);
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [token]);

  const emit = useCallback((eventOrMessage: string | Record<string, any>, ...args: any[]) => {
    if (!socketRef.current) return;
    if (typeof eventOrMessage === 'object' && eventOrMessage.type) {
      const { type, ...rest } = eventOrMessage;
      socketRef.current.emit(type, rest);
    } else {
      socketRef.current.emit(eventOrMessage as string, ...args);
    }
  }, []);

  return (
    <SocketIOContext.Provider value={{
      socket: socketRef.current,
      isConnected,
      recovered,
      emit,
      setActiveSession,
      lastReconnectResult
    }}>
      {children}
    </SocketIOContext.Provider>
  );
}

export const useSocketIO = () => useContext(SocketIOContext);
```

**Step 2: Wire useChatRealtimeHandlers to persist and restore session**

In `src/components/chat/hooks/useChatRealtimeHandlers.ts`, two changes:

**Change A:** When `session-created` is received (around line 288-303), also call `setActiveSession`:

After the existing `sessionStorage.setItem('pendingSessionId', ...)` line (line 290), add:
```ts
          setActiveSession(latestMessage.sessionId, provider);
```

This requires adding `setActiveSession` to the hook's dependencies. Extract it from `useSocketIO()`:

At the top of the hook where `useSocketIO()` is called (line 157), change:
```ts
  const { isConnected, socket } = useSocketIO();
```
To:
```ts
  const { isConnected, socket, setActiveSession, lastReconnectResult } = useSocketIO();
```

**Change B:** When `claude-complete` (or `cursor-result`, `codex-complete`) is received, clear the active session:

In the `claude-complete` handler (search for `case 'claude-complete':`), add at the end of that case:
```ts
          setActiveSession(null);
```

Similarly in `cursor-result` and `codex-complete` handlers.

**Change C:** Handle reconnect result — restore state from snapshot.

Add a new `useEffect` that watches `lastReconnectResult`:

```ts
  // Handle session reconnect result
  useEffect(() => {
    if (!lastReconnectResult) return;
    const { isActive, snapshot, writerSwapped } = lastReconnectResult;

    if (isActive && snapshot) {
      // Restore pending permissions
      if (snapshot.pendingPermissions?.length > 0) {
        setPendingPermissionRequests(snapshot.pendingPermissions);
      }

      // Restore streaming state
      if (snapshot.status === 'streaming' || snapshot.status === 'awaiting_permission') {
        setIsLoading(true);
        setCanAbortSession(true);
      }

      // Restore token budget
      if (snapshot.tokenBudget) {
        setTokenBudget(snapshot.tokenBudget);
      }

      console.log('[Reconnect] State restored:', {
        status: snapshot.status,
        pendingPermissions: snapshot.pendingPermissions?.length,
        writerSwapped
      });
    }
  }, [lastReconnectResult]);
```

**Step 3: Commit**

```bash
git add src/contexts/SocketIOContext.tsx src/components/chat/hooks/useChatRealtimeHandlers.ts
git commit -m "feat: frontend session persistence and reconnect-session on connect"
```

---

### Task 4: Set activeSession when starting a new query

**Files:**
- Modify: `src/components/chat/hooks/useChatComposerState.ts`

**Step 1: Call setActiveSession when sending claude-command**

The composer is where chat commands originate. When the user sends a message, we need to persist the session info.

Find where `claude-command` is emitted (search for `sendMessage` with `claude-command` type). Add `setActiveSession` call right after:

First, import `useSocketIO` and extract `setActiveSession`:

At the top of the hook, add:
```ts
const { setActiveSession } = useSocketIO();
```

Then, wherever `sendMessage({ type: 'claude-command', ... })` is called, add immediately after:
```ts
setActiveSession(sessionIdUsed, provider);
```

where `sessionIdUsed` is the sessionId being sent in the command options.

Similarly for `cursor-command` and `codex-command`.

Also: when `session-created` arrives with a new sessionId for a fresh session, the realtimeHandlers already persist it (Task 3 Change A).

**Step 2: Clear activeSession on session switch**

In `useChatSessionState.ts`, when the user switches to a different session (the `sessionChanged` branch around line 329), clear the active session if the old session is no longer streaming:

```ts
if (sessionChanged) {
  setActiveSession(null);
  // ... existing code
}
```

**Step 3: Commit**

```bash
git add src/components/chat/hooks/useChatComposerState.ts src/components/chat/hooks/useChatSessionState.ts
git commit -m "feat: persist active session on command send, clear on session switch"
```

---

### Task 5: Suppress session_id log spam

**Files:**
- Modify: `server/claude-sdk.js`

**Step 1: Remove the noisy log**

Change line 1144 from:
```js
        console.log('No session_id in message or already captured. message.session_id:', message.session_id, 'capturedSessionId:', capturedSessionId);
```

To nothing (remove the entire `else` block body), or replace with a one-time log:
```js
        // session_id already captured, normal for all subsequent messages
```

This log fires for every single streaming message and fills the server output with hundreds of identical lines, making real debugging impossible.

**Step 2: Commit**

```bash
git add server/claude-sdk.js
git commit -m "fix: remove session_id log spam that fires on every streaming message"
```

---

### Task 6: Reset disconnect side-effect in useChatRealtimeHandlers

**Files:**
- Modify: `src/components/chat/hooks/useChatRealtimeHandlers.ts`

**Step 1: Don't reset loading/abort state on disconnect if session is active**

Currently, lines 159-169 reset `isLoading`, `canAbortSession`, and `claudeStatus` whenever the socket disconnects. This is wrong during a reconnect — the session is still active on the server.

Change:
```ts
  useEffect(() => {
    if (!isConnected) {
      setIsLoading(false);
      setCanAbortSession(false);
      setClaudeStatus(null);
    }
  }, [isConnected, setIsLoading, setCanAbortSession, setClaudeStatus]);
```

To:
```ts
  useEffect(() => {
    if (!isConnected) {
      // Don't reset streaming UI state if we have an active session that may reconnect.
      // The reconnect-session handler will restore correct state.
      const hasActiveSession = !!sessionStorage.getItem('socketio-active-session');
      if (!hasActiveSession) {
        setIsLoading(false);
        setCanAbortSession(false);
        setClaudeStatus(null);
      }
    }
  }, [isConnected, setIsLoading, setCanAbortSession, setClaudeStatus]);
```

**Step 2: Commit**

```bash
git add src/components/chat/hooks/useChatRealtimeHandlers.ts
git commit -m "fix: preserve streaming UI state during reconnect if session is active"
```

---

### Task 7: End-to-end manual verification

**Files:** None (testing only)

**Step 1: Start dev server**

```bash
npm run dev
```

**Step 2: Test normal flow (no refresh)**

1. Open http://localhost:5174
2. Login
3. Send a message to Claude
4. Verify streaming response works end to end
5. Check server console: no session_id spam
6. Check browser console: `setActiveSession` called

**Step 3: Test refresh during streaming**

1. Send a long-running message (e.g., "Write a detailed essay about...")
2. While Claude is streaming, press F5 (browser refresh)
3. Expected:
   - Browser reloads, reconnects
   - Console shows: `[SocketIO] Attempting session reconnect: <sessionId>`
   - Console shows: `[SocketIO] Reconnect result: { success: true, writerSwapped: true, isActive: true, ... }`
   - Streaming resumes — new messages appear in the chat
   - Buffered messages (sent during disconnect window) are flushed
   - Loading spinner / abort button are restored
   - If permission request was pending, it reappears

**Step 4: Test refresh after completion**

1. Wait for Claude to finish responding
2. Refresh browser
3. Expected: `reconnect-session` finds session no longer active, cleans up sessionStorage
4. No stale UI state

**Step 5: Test tab switch (visibility)**

1. Start streaming
2. Switch to another tab for 5+ seconds
3. Switch back
4. Expected: `useVisibilitySync` fires state snapshot, UI stays consistent

**Step 6: Commit final state**

```bash
git add -A
git commit -m "test: verify session reconnect works end-to-end"
```

(Only if there are any remaining fixups discovered during testing)

---

## Summary of Changes

| File | Change |
|------|--------|
| `server/socket-writer.js` | Resilient writer with buffer + `updateSocket()` + `detach()` |
| `server/index.js` | `reconnect-session` event handler |
| `server/claude-sdk.js` | Fix `reconnectSessionWriter` to use `updateSocket()`, remove log spam |
| `src/contexts/SocketIOContext.tsx` | Persist active session, emit `reconnect-session` on connect |
| `src/components/chat/hooks/useChatRealtimeHandlers.ts` | Persist sessionId on events, restore state from snapshot, fix disconnect reset |
| `src/components/chat/hooks/useChatComposerState.ts` | Call `setActiveSession` on command send |
| `src/components/chat/hooks/useChatSessionState.ts` | Clear active session on session switch |

## Data Flow After Fix

```
1. User sends message → setActiveSession(sessionId) → sessionStorage
2. Server creates writer → writer.socketRef = socket
3. Claude SDK streams → writer.send() → socket.emit()
4. User refreshes → socket disconnects → writer.socketRef.connected = false
5. Claude SDK continues → writer.send() → messages go to buffer[]
6. New socket connects → SocketIOContext reads sessionStorage
7. Frontend emits reconnect-session(sessionId)
8. Server: socket.join(room), reconnectSessionWriter(sessionId, newSocket)
9. writer.updateSocket(newSocket) → flush buffer → resume streaming
10. Server sends state snapshot → frontend restores UI
```
