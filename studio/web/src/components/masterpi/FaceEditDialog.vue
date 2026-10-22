<script setup>
import { reactive, ref } from 'vue';
import { useFaces } from '@/composables/useFaces';

const { saveEdit } = useFaces();

const visible = ref(false);
const form = reactive({ key: '', oldName: '', oldId: '', name: '', id: '', saving: false });

function open(row) {
  Object.assign(form, {
    key: row.id,
    oldName: row.name,
    oldId: row.id,
    name: row.name,
    id: row.id,
    saving: false,
  });
  visible.value = true;
}

async function save() {
  form.saving = true;
  try {
    const ok = await saveEdit({
      key: form.key,
      oldName: form.oldName,
      oldId: form.oldId,
      name: form.name,
      id: form.id,
    });
    if (ok) visible.value = false;
  } finally {
    form.saving = false;
  }
}

defineExpose({ open });
</script>

<template>
  <el-dialog v-model="visible" title="✏️ 编辑成员（ID 与称呼一起改）" width="460px">
    <el-form label-width="56px" @submit.prevent>
      <el-form-item label="称呼">
        <el-input v-model="form.name" placeholder="成员称呼（不能为空）" size="small" @keyup.enter="save" />
      </el-form-item>
      <el-form-item label="ID">
        <el-input
          v-model="form.id"
          placeholder="p_ 开头 4~16 位，不含 i/l/o/0/1"
          size="small"
          @keyup.enter="save"
        />
      </el-form-item>
    </el-form>
    <div class="hint">保持原值即视为不改动；两项均全局查重，可一次同时改。</div>
    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button type="primary" :loading="form.saving" @click="save">💾 保存</el-button>
    </template>
  </el-dialog>
</template>
