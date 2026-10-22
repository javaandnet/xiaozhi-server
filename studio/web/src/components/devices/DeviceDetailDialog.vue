<script setup>
import { ref } from 'vue';

const visible = ref(false);
const device = ref(null);

function open(row) {
  device.value = row;
  visible.value = true;
}

defineExpose({ open });
</script>

<template>
  <el-dialog v-model="visible" title="设备详情" width="560px">
    <pre class="dump mono">{{ device ? JSON.stringify(device, null, 2) : '' }}</pre>
  </el-dialog>
</template>
