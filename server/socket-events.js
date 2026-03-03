export const MESSAGE_TYPES = {
  CLAUDE_COMMAND: 'claude-command',
  CLAUDE_RESPONSE: 'claude-response',
  CLAUDE_COMPLETE: 'claude-complete',
  CLAUDE_ERROR: 'claude-error',
  CLAUDE_PERMISSION_REQUEST: 'claude-permission-request',
  CLAUDE_PERMISSION_RESPONSE: 'claude-permission-response',
  CLAUDE_STATUS: 'claude-status',
  SESSION_CREATED: 'session-created',
  PROJECTS_UPDATED: 'projects_updated',
  TOKEN_BUDGET: 'token-budget',
  LOADING_PROGRESS: 'loading_progress'
};

export function setupEventHandlers(io, callbacks = {}) {
  io.on('connection', (socket) => {
    if (callbacks.onClaudeCommand) {
      socket.on(MESSAGE_TYPES.CLAUDE_COMMAND, (data) => {
        callbacks.onClaudeCommand(socket, data);
      });
    }

    if (callbacks.onPermissionResponse) {
      socket.on(MESSAGE_TYPES.CLAUDE_PERMISSION_RESPONSE, (data) => {
        callbacks.onPermissionResponse(socket, data);
      });
    }
  });
}
