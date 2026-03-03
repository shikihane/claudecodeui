const sessionStates = new Map();

export function createSessionState(sessionId, provider) {
  const state = {
    sessionId, provider, status: 'idle', messages: [],
    currentStreamingText: '', pendingPermissions: [],
    tokenBudget: null, lastActivity: Date.now()
  };
  sessionStates.set(sessionId, state);
  return state;
}

export function getSessionState(sessionId) {
  return sessionStates.get(sessionId) || null;
}

export function updateSessionState(sessionId, updates) {
  const s = sessionStates.get(sessionId);
  if (!s) return null;
  Object.assign(s, updates, { lastActivity: Date.now() });
  return s;
}

export function deleteSessionState(sessionId) {
  return sessionStates.delete(sessionId);
}

export function addStreamingChunk(sessionId, chunk) {
  const s = sessionStates.get(sessionId);
  if (s) { s.currentStreamingText += chunk; s.lastActivity = Date.now(); }
}

export function finalizeStreamingMessage(sessionId) {
  const s = sessionStates.get(sessionId);
  if (!s || !s.currentStreamingText) return;
  s.messages.push({ role: 'assistant', content: s.currentStreamingText, timestamp: Date.now() });
  s.currentStreamingText = '';
  s.status = 'idle';
}

export function addPendingPermission(sessionId, perm) {
  const s = sessionStates.get(sessionId);
  if (s) { s.pendingPermissions.push(perm); s.status = 'awaiting_permission'; }
}

export function removePendingPermission(sessionId, requestId) {
  const s = sessionStates.get(sessionId);
  if (!s) return;
  s.pendingPermissions = s.pendingPermissions.filter(p => p.requestId !== requestId);
  if (!s.pendingPermissions.length && s.status === 'awaiting_permission') s.status = 'streaming';
}

export function getStateSnapshot(sessionId) {
  const state = sessionStates.get(sessionId);
  if (!state) return { status: 'idle' };

  return {
    sessionId: state.sessionId,
    provider: state.provider,
    status: state.status,
    messages: state.messages,
    currentStreamingText: state.currentStreamingText,
    pendingPermissions: state.pendingPermissions,
    tokenBudget: state.tokenBudget,
    lastActivity: state.lastActivity
  };
}
