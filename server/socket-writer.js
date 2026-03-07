/**
 * Creates a writer adapter that wraps a Socket.IO socket to provide
 * the same ws.send(data) interface used by claude-sdk.js, cursor-cli.js, and openai-codex.js.
 *
 * The providers call ws.send({type, sessionId, data, ...rest}).
 * This adapter converts that to socket.emit(type, {sessionId, data, ...rest}).
 */
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
