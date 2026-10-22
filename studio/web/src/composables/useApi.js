/**
 * Shared request helper for views/components.
 * ElMessage / ElMessageBox come from unplugin-auto-import (Element Plus resolver),
 * so they are intentionally not imported here.
 */
import { ref } from 'vue';

/** Wrap an async action with a loading flag and a failure toast. */
export function useApi() {
  const loading = ref(false);

  async function run(fn, { onError = null } = {}) {
    loading.value = true;
    try {
      return await fn();
    } catch (e) {
      const msg = e?.message || String(e);
      if (msg === 'login required') throw e;
      if (onError) onError(msg);
      else ElMessage.error(msg);
      return undefined;
    } finally {
      loading.value = false;
    }
  }

  return { loading, run };
}

/** Two-step confirmation used by destructive actions (delete / disconnect). */
export function confirmAction(message, title = '安全确认') {
  return ElMessageBox.confirm(message, title, {
    type: 'warning',
    confirmButtonText: '确认',
    cancelButtonText: '取消',
  })
    .then(() => true)
    .catch(() => false);
}
