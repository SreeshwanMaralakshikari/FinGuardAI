/**
 * @file server.js
 * @description Production entry point.
 *   1. Load .env (local only) — MUST stay the first import
 *   2. Validate environment variables (fail fast)
 *   3. Connect to MongoDB Atlas
 *   4. Create one HTTP server shared by Express and Socket.io
 *   5. Configure Socket.io: CORS allowlist, origin check, cookie auth, rooms
 *   6. listen() on process.env.PORT (Render injects it)
 *   7. Graceful shutdown on SIGTERM/SIGINT (Render sends SIGTERM on every
 *      deploy and may restart free instances at any time)
 *   8. Fatal errors (uncaught exception / unhandled rejection) are logged and
 *      trigger the same graceful shutdown with exit code 1 — Render then
 *      restarts the service from a clean state
 * @phase Phase 2 spec → Phase 9 (production implementation)
 */
import './config/loadEnv.js'; // ⚠️ keep first — see config/loadEnv.js

import http from 'node:http';
import { Server } from 'socket.io';

import validateEnv from './config/validateEnv.js';
import connectDB, { disconnectDB } from './config/db.js';
import { corsOptions, isOriginAllowed } from './config/corsOptions.js';
import app from './app.js';
import { setIO, userRoom, roleRoom } from './utils/socketManager.js';
import { socketAuthMiddleware } from './utils/socketAuth.js';

const PORT = Number(process.env.PORT) || 5000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647; // setTimeout upper bound (~24.8 days)

const createSocketServer = (httpServer) => {
  const io = new Server(httpServer, {
    // CORS headers for the HTTP long-polling transport.
    cors: {
      origin: corsOptions.origin,
      credentials: true,
      methods: ['GET', 'POST'],
    },
    // Browsers do NOT apply CORS to WebSocket upgrades, so check the Origin
    // header explicitly for every handshake (polling and websocket).
    allowRequest: (req, callback) => {
      const { origin } = req.headers;
      callback(null, !origin || isOriginAllowed(origin));
    },
    // Heartbeat: Socket.io defaults (pingInterval 25 s, pingTimeout 20 s) are
    // kept. The client's pong replies are inbound WebSocket messages, which
    // Render counts as traffic — an open, logged-in tab keeps the free
    // instance from spinning down.
  });

  io.use(socketAuthMiddleware);

  io.on('connection', (socket) => {
    const { id: userId, role } = socket.data.user;

    // Room names (helpers shared with utils/socketManager.js):
    //   userRoom(id)   → createNotification(): getIO().to(recipientId).emit('new-notification')
    //   roleRoom(role) → admin-only events ('fraud_alert', 'simulation_*') go to role:ADMIN
    socket.join(userRoom(userId));
    socket.join(roleRoom(role));

    // Backward compatibility with the Phase 6 hooks, which emit 'join' on
    // connect. Only the authenticated user's own room can be joined.
    socket.on('join', (requestedId) => {
      if (userRoom(requestedId) === userRoom(userId)) socket.join(userRoom(userId));
    });

    // Drop the socket when its JWT expires — same lifetime as the REST session.
    const { tokenExpiresAt } = socket.data;
    if (tokenExpiresAt) {
      const expiryTimer = setTimeout(
        () => socket.disconnect(true),
        Math.min(Math.max(tokenExpiresAt - Date.now(), 0), MAX_TIMER_MS)
      );
      socket.on('disconnect', () => clearTimeout(expiryTimer));
    }
  });

  return io;
};

let httpServer = null;
let io = null;
let isShuttingDown = false;

/**
 * Stop accepting work, let in-flight requests finish, close sockets and the
 * DB connection, then exit. Idempotent — a second signal is ignored.
 * @param {string} reason
 * @param {number} exitCode
 */
const shutdown = (reason, exitCode = 0) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`[Server] ${reason} — shutting down gracefully`);

  const forceExit = setTimeout(() => {
    console.error('[Server] Forced exit after timeout');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  const finish = async () => {
    try {
      await disconnectDB();
    } catch (err) {
      console.error('[Server] Error while closing MongoDB:', err.message);
    }
    console.log('[Server] Closed cleanly');
    process.exit(exitCode);
  };

  // io.close() disconnects every socket, then calls httpServer.close(),
  // which stops accepting connections and waits for in-flight requests.
  if (io) io.close(finish);
  else if (httpServer) httpServer.close(finish);
  else finish();
};

const start = async () => {
  validateEnv();
  await connectDB();

  httpServer = http.createServer(app);

  // Keep idle keep-alive sockets open longer than a typical reverse-proxy idle
  // timeout (60 s). Node's 5 s default lets the proxy reuse a socket Node has
  // just closed, which shows up as sporadic 502s. headersTimeout must exceed it.
  httpServer.keepAliveTimeout = 65_000;
  httpServer.headersTimeout = 66_000;

  io = createSocketServer(httpServer);
  setIO(io);

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[Server] FinGuardAI API listening on port ${PORT} (${process.env.NODE_ENV ?? 'development'})`);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM received'));
process.on('SIGINT', () => shutdown('SIGINT received'));

// Unknown state after these — log with stack, then restart cleanly.
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled promise rejection:', reason);
  shutdown('Unhandled promise rejection', 1);
});
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception:', err);
  shutdown('Uncaught exception', 1);
});

start().catch((err) => {
  console.error('[Server] Failed to start:', err.message);
  process.exit(1);
});
