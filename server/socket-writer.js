export function createSocketWriter(socket, sessionId = null) {
  return {
    send({ type, data }) {
      socket.emit(type, { data, sessionId });
    }
  };
}

export function createBroadcastWriter(io, sessionId = null) {
  return {
    send({ type, data }) {
      if (sessionId) {
        io.to(sessionId).emit(type, { data, sessionId });
      } else {
        io.emit(type, { data });
      }
    }
  };
}
