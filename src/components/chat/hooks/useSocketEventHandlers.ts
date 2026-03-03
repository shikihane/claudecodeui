import { useEffect } from 'react';
import { Socket } from 'socket.io-client';

interface EventHandlerCallbacks {
  onClaudeResponse: (data: any) => void;
  onClaudeComplete: (data: any) => void;
  onClaudeError: (data: any) => void;
  onPermissionRequest: (data: any) => void;
  onClaudeStatus: (data: any) => void;
  onProjectsUpdated: (data: any) => void;
  onSessionCreated: (data: any) => void;
  onTokenBudget: (data: any) => void;
}

export function useSocketEventHandlers(
  socket: Socket | null,
  sessionId: string | null,
  callbacks: Partial<EventHandlerCallbacks>
) {
  useEffect(() => {
    if (!socket) return;

    const handlers: [string, (data: any) => void][] = [
      ['claude-response', (data) => {
        if (data.sessionId && data.sessionId !== sessionId) return;
        callbacks.onClaudeResponse?.(data);
      }],
      ['claude-complete', (data) => {
        callbacks.onClaudeComplete?.(data);
      }],
      ['claude-error', (data) => {
        callbacks.onClaudeError?.(data);
      }],
      ['claude-permission-request', (data) => {
        callbacks.onPermissionRequest?.(data);
      }],
      ['claude-status', (data) => {
        callbacks.onClaudeStatus?.(data);
      }],
      ['projects_updated', (data) => {
        callbacks.onProjectsUpdated?.(data);
      }],
      ['session-created', (data) => {
        callbacks.onSessionCreated?.(data);
      }],
      ['token-budget', (data) => {
        callbacks.onTokenBudget?.(data);
      }]
    ];

    handlers.forEach(([event, handler]) => socket.on(event, handler));

    return () => {
      handlers.forEach(([event, handler]) => socket.off(event, handler));
    };
  }, [socket, sessionId, callbacks]);
}
