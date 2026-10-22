/**
 * Server/environment probe — module-level singleton so the header badges and the
 * firmware workbench (which edits otaUrl in place) share one copy.
 */
import { reactive } from 'vue';
import { getEnv } from '@/api/studio';

const env = reactive({
  checks: {},
  ports: [],
  repoDir: '',
  repoVersion: '',
  gitBranch: '',
  otaUrl: '',
  otaUrlFallback: '',
  dataBinDir: '',
  deviceDb: '',
  allOk: false,
});

let loaded = false;

export function useEnv() {
  async function load() {
    try {
      Object.assign(env, await getEnv());
      loaded = true;
    } catch (e) {
      console.warn('[useEnv] env probe failed:', e.message);
    }
  }

  function firstLoad() {
    if (!loaded) return load();
    return Promise.resolve();
  }

  return { env, load, firstLoad };
}
