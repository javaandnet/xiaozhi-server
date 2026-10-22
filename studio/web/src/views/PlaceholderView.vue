<script setup>
import { CONSOLE_ROOT } from '@/api/http';

const props = defineProps({
  title: { type: String, required: true },
  legacyKey: { type: String, required: true },
});

const legacyUrl = `${CONSOLE_ROOT}/#/${props.legacyKey}`;
</script>

<template>
  <el-empty :description="`${props.title} 尚未迁移到 Element Plus 工程版`">
    <el-link :href="legacyUrl" target="_blank" type="primary">前往旧版控制台打开该页</el-link>
    <div class="hint" style="margin-top: 8px">迁移顺序：设备管理 → 总览 → 固件工作台 → MasterPi → 家庭设备。</div>
  </el-empty>
</template>
