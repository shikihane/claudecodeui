/**
 * Socket.IO room management + at-least-once event delivery for background tasks.
 *
 * Room management replaces the old connectedClients Set.
 * Pending events queue provides MQTT QoS 1 style delivery:
 *   1. emitTaskEvent() stores the event and broadcasts via Socket.IO room.
 *   2. Client sends 'ack-event' → ackEvent() removes it from the queue.
 *   3. On reconnect, client sends 'sync-background-events' →
 *      syncPendingEvents() re-sends every un-ACK'd event for that session.
 *   4. Client de-duplicates by eventId so repeated delivery is harmless.
 *   5. A periodic sweeper removes events older than PENDING_TTL_MS.
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Socket.IO instance (set once via setupRoomManagement)
// ---------------------------------------------------------------------------

/** @type {import('socket.io').Server | null} */
let _io = null;

// ---------------------------------------------------------------------------
// Room management
// ---------------------------------------------------------------------------

export function setupRoomManagement(io) {
  _io = io;

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

// ---------------------------------------------------------------------------
// Pending-event queue (at-least-once delivery)
// ---------------------------------------------------------------------------

const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // sweep every 5 min

/** sessionId → Map<eventId, { data, createdAt }> */
const pendingEvents = new Map();

/**
 * Emit a task lifecycle event with at-least-once delivery via Socket.IO.
 *
 * The event is sent to the Socket.IO room matching the sessionId so that
 * only clients subscribed to that session receive it.
 *
 * @param {string} sessionId - The session this event belongs to
 * @param {object} data      - The event payload (must include `type`)
 */
export function emitTaskEvent(sessionId, data) {
  const eventId = crypto.randomUUID();
  data.eventId = eventId;
  data.sessionId = sessionId;

  // Store until ACK'd
  if (!pendingEvents.has(sessionId)) {
    pendingEvents.set(sessionId, new Map());
  }
  pendingEvents.get(sessionId).set(eventId, { data, createdAt: Date.now() });

  // Best-effort broadcast to ALL connected sockets (not room-based).
  // Background task events are low-volume and must survive room membership changes
  // (e.g. streaming ends → setActiveSession(null) → client leaves room).
  // The frontend filters by sessionId and deduplicates by eventId.
  if (_io && data.type) {
    const { type, ...rest } = data;
    _io.emit(type, rest);
  }
}

/**
 * Acknowledge an event — remove from pending queue.
 *
 * @param {string} sessionId
 * @param {string} eventId
 */
export function ackEvent(sessionId, eventId) {
  const sessionPending = pendingEvents.get(sessionId);
  if (sessionPending) {
    sessionPending.delete(eventId);
    if (sessionPending.size === 0) {
      pendingEvents.delete(sessionId);
    }
  }
}

/**
 * Re-send all un-ACK'd events for a session (called on client reconnect).
 *
 * @param {string} sessionId
 * @param {import('socket.io').Socket} socket - The reconnected Socket.IO socket
 */
export function syncPendingEvents(sessionId, socket) {
  const sessionPending = pendingEvents.get(sessionId);
  if (!sessionPending || sessionPending.size === 0) return;

  console.log(`[SYNC] Sending ${sessionPending.size} pending events for session ${sessionId}`);
  for (const [, { data }] of sessionPending) {
    if (socket.connected && data.type) {
      const { type, ...rest } = data;
      socket.emit(type, rest);
    }
  }
}

// Periodic sweeper — evict events older than PENDING_TTL_MS
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, events] of pendingEvents) {
    for (const [eventId, { createdAt }] of events) {
      if (now - createdAt > PENDING_TTL_MS) {
        events.delete(eventId);
      }
    }
    if (events.size === 0) {
      pendingEvents.delete(sessionId);
    }
  }
}, SWEEP_INTERVAL_MS);
