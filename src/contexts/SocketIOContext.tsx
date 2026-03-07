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
    // Support legacy {type, ...rest} format from old WebSocket sendMessage calls
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
