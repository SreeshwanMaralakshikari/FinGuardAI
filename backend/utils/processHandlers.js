/**
 * @file utils/processHandlers.js
 * @description C-03: process-level error policy for server.js, in a small function so it
 *   can be unit-tested with a fake process object.
 *   • unhandledRejection — logged with its stack, the server KEEPS RUNNING. One forgotten
 *     promise must not turn into a restart (a cold start of about a minute on Render free)
 *     for every user. All route handlers are asyncHandler-wrapped, so this is the safety net
 *     for background work only.
 *   • uncaughtException — the process state is unknown: log and shut down gracefully with exit code 1.
 */

/**
 * @param {{ on: (event: string, listener: (...args: any[]) => void) => unknown }} proc  usually `process`
 * @param {(reason: string, exitCode?: number) => void} shutdown  graceful shutdown from server.js
 */
export const registerProcessErrorHandlers = (proc, shutdown) => {
  proc.on('unhandledRejection', (reason) => {
    console.error('[Server] Unhandled promise rejection (server keeps running):', reason);
  });
  proc.on('uncaughtException', (err) => {
    console.error('[Server] Uncaught exception:', err);
    shutdown('Uncaught exception', 1);
  });
};
