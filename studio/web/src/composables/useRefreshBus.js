/**
 * Header refresh -> active view reload.
 * Views register their own reload function in setup(); the shell only calls it.
 */
let handler = null;

export function useRefreshBus() {
  return {
    register(fn) {
      handler = fn;
    },
    unregister() {
      handler = null;
    },
  };
}

export async function refreshCurrentView() {
  if (handler) await handler();
}
