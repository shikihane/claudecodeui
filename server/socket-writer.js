/**
 * Creates a writer adapter that wraps a Socket.IO socket to provide
 * the same ws.send(data) interface used by claude-sdk.js, cursor-cli.js, and openai-codex.js.
 *
 * The providers call ws.send({type, sessionId, data, ...rest}).
 * This adapter converts that to socket.emit(type, {sessionId, data, ...rest}).
 */
export function createSocketWriter(socket) {
  return {
    isWebSocketWriter: true,
    send(msg) {
      if (!msg || !msg.type) return;
      const { type, ...rest } = msg;
      socket.emit(type, rest);
    }
  };
}

export function createBroadcastWriter(io, room = null) {
  return {
    isWebSocketWriter: true,
    send(msg) {
      if (!msg || !msg.type) return;
      const { type, ...rest } = msg;
      if (room) {
        io.to(room).emit(type, rest);
      } else {
        io.emit(type, rest);
      }
    }
  };
}
