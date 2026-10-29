import { createRouter, createWebHashHistory } from 'vue-router';
import OverviewView from '@/views/OverviewView.vue';
import DevicesView from '@/views/DevicesView.vue';
import FirmwareView from '@/views/FirmwareView.vue';
import MasterPiView from '@/views/MasterPiView.vue';
import HomeView from '@/views/HomeView.vue';
import InterfacesView from '@/views/InterfacesView.vue';

// Hash history keeps the console shareable behind any mount prefix (/firmware/app/
// locally, /xiaozhi/firmware/app/ on the cloud) without server-side rewrites.
const routes = [
  // Devices is the first migrated page, so it owns the default entry until the
  // remaining views are ported from the legacy single-file console.
  { path: '/', redirect: '/devices' },
  { path: '/overview', name: 'overview', component: OverviewView, meta: { title: '总览' } },
  { path: '/devices', name: 'devices', component: DevicesView, meta: { title: '设备管理' } },
  { path: '/firmware', name: 'firmware', component: FirmwareView, meta: { title: '固件工作台' } },
  { path: '/masterpi', name: 'masterpi', component: MasterPiView, meta: { title: 'MasterPi' } },
  // 遥控已并入 MasterPi 页（游戏手柄卡片）；旧链接重定向兼容
  { path: '/robot', redirect: '/masterpi' },
  { path: '/home', name: 'home', component: HomeView, meta: { title: '家庭设备' } },
  { path: '/interfaces', name: 'interfaces', component: InterfacesView, meta: { title: '接口管理' } },
];

export default createRouter({ history: createWebHashHistory(), routes });
