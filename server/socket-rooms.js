/**
 * Socket.IO 房间管理
 * 替代原有的 connectedClients Set
 */

export function setupRoomManagement(io) {
  io.on('connection', (socket) => {
    socket.on('join-session', (sessionId) => {
      socket.join(sessionId);
      socket.emit('joined-session', sessionId);
      console.log(`Socket ${socket.id} joined session ${sessionId}`);
    });

    socket.on('leave-session', (sessionId) => {
      socket.leave(sessionId);
      socket.emit('left-session', sessionId);
      console.log(`Socket ${socket.id} left session ${sessionId}`);
    });

    socket.on('disconnect', () => {
      console.log(`Socket ${socket.id} disconnected, rooms auto-cleaned`);
    });
  });
}

export function broadcastToSession(io, sessionId, event, data) {
  io.to(sessionId).emit(event, data);
}

export function broadcastToAll(io, event, data) {
  io.emit(event, data);
}
