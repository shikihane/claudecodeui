let seq = 0;
let heartbeatTimer = null;

export function setupHeartbeat(io, { intervalMs = 15000 } = {}) {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  seq = 0;

  heartbeatTimer = setInterval(() => {
    seq++;
    io.emit('heartbeat', { seq, ts: Date.now() });
  }, intervalMs);

  return () => {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  };
}
