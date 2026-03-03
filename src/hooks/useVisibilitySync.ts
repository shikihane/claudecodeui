import { useEffect, useRef } from 'react';
import { useSocketIO } from '../contexts/SocketIOContext';

const FREEZE_THRESHOLD_MS = 3000;

export function useVisibilitySync(
  sessionId: string | null,
  onSnapshot: (snapshot: any) => void
) {
  const { socket, isConnected } = useSocketIO();
  const hiddenAtRef = useRef<number>(0);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        hiddenAtRef.current = Date.now();
      } else {
        const frozenMs = Date.now() - hiddenAtRef.current;
        if (frozenMs > FREEZE_THRESHOLD_MS && isConnected && sessionId && socket) {
          socket.emit('request-state-snapshot', sessionId, (snapshot: any) => {
            if (snapshot) onSnapshot(snapshot);
          });
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [socket, isConnected, sessionId, onSnapshot]);
}
