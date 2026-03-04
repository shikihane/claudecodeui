import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './AuthContext';

interface SocketIOContextType {
  socket: Socket | null;
  isConnected: boolean;
  recovered: boolean;
  emit: (eventOrMessage: string | Record<string, any>, ...args: any[]) => void;
}

const SocketIOContext = createContext<SocketIOContextType>({
  socket: null,
  isConnected: false,
  recovered: false,
  emit: () => {}
});

export function SocketIOProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [recovered, setRecovered] = useState(false);

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
    <SocketIOContext.Provider value={{ socket: socketRef.current, isConnected, recovered, emit }}>
      {children}
    </SocketIOContext.Provider>
  );
}

export const useSocketIO = () => useContext(SocketIOContext);
