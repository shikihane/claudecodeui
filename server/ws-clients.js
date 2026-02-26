/**
 * Shared WebSocket client registry + "at least once" event delivery.
 *
 * Both index.js (connection management) and claude-sdk.js (background monitors)
 * import from here to avoid circular dependencies.
 *
 * Delivery guarantee (MQTT QoS 1 style):
 *   1. emitTaskEvent() stores the event in pendingEvents and broadcasts it.
 *   2. Client sends 'ack-event' after processing → ackEvent() removes it.
 *   3. On WebSocket reconnect the client sends 'sync-background-events' →
 *      syncPendingEvents() re-sends every un-ACK'd event for that session.
 *   4. Client de-duplicates by eventId so repeated delivery is harmless.
 *   5. A periodic sweeper removes events older than PENDING_TTL_MS.
 */

import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Connected-client registry (raw WebSocket objects)
// ---------------------------------------------------------------------------

/** @type {Set<import('ws').WebSocket>} */
const connectedClients = new Set();

/**
 * Best-effort broadcast to every open WebSocket.
 * @param {object} data
 */
function broadcastMessage(data) {
  const msg = JSON.stringify(data);
  connectedClients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  });
}

// ---------------------------------------------------------------------------
// Pending-event queue  (at-least-once delivery)
// ---------------------------------------------------------------------------

const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // sweep every 5 min

/** sessionId → Map<eventId, { data, createdAt }> */
const pendingEvents = new Map();

/**
 * Emit a task lifecycle event with at-least-once delivery.
 *
 * @param {string} sessionId - The session this event belongs to
 * @param {object} data      - The event payload (will be augmented with eventId)
 */
function emitTaskEvent(sessionId, data) {
  const eventId = crypto.randomUUID();
  data.eventId = eventId;
  data.sessionId = sessionId; // ensure sessionId is always present

  // Store until ACK'd
  if (!pendingEvents.has(sessionId)) {
    pendingEvents.set(sessionId, new Map());
  }
  pendingEvents.get(sessionId).set(eventId, { data, createdAt: Date.now() });

  // Best-effort push
  broadcastMessage(data);
}

/**
 * Acknowledge an event — remove from pending queue.
 *
 * @param {string} sessionId
 * @param {string} eventId
 */
function ackEvent(sessionId, eventId) {
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
 * @param {import('ws').WebSocket} rawWs - The newly connected raw WebSocket
 */
function syncPendingEvents(sessionId, rawWs) {
  const sessionPending = pendingEvents.get(sessionId);
  if (!sessionPending || sessionPending.size === 0) return;

  console.log(`[SYNC] Sending ${sessionPending.size} pending events for session ${sessionId}`);
  for (const [, { data }] of sessionPending) {
    if (rawWs.readyState === 1) {
      rawWs.send(JSON.stringify(data));
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

export {
  connectedClients,
  broadcastMessage,
  emitTaskEvent,
  ackEvent,
  syncPendingEvents,
  pendingEvents,
};
