/** Robot action catalog (/api/robot/action-types) — loaded once, shared everywhere. */
import { computed, ref } from 'vue';
import { getRobotActionTypes } from '@/api/mcp';

const actionTypes = ref([]);

export function useRobotActions() {
  const allActionIds = computed(() => actionTypes.value.map((a) => a.id));
  const actionGroups = computed(() => {
    const m = new Map();
    for (const a of actionTypes.value) {
      const k = a.categoryLabel || a.category;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(a);
    }
    return [...m.entries()].map(([label, items]) => ({ label, items }));
  });

  async function ensureLoaded() {
    if (actionTypes.value.length) return;
    try {
      const r = await getRobotActionTypes();
      if (r && r.ok) actionTypes.value = r.items || [];
    } catch (e) {
      console.warn('[useRobotActions] load failed:', e.message);
    }
  }

  return { actionTypes, allActionIds, actionGroups, ensureLoaded };
}
