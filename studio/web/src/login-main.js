import { createApp } from 'vue';
import 'element-plus/theme-chalk/dark/css-vars.css';
import './styles/console.css';
import './styles/login.css';
import LoginPanel from './components/LoginPanel.vue';
import { APP_ROOT } from './api/http';

// Keep the post-login target on our own origin/path (no open redirect).
const back = new URLSearchParams(location.search).get('redirect');
const redirectTo = back && back.startsWith('/') ? back : `${APP_ROOT}/`;

createApp(LoginPanel, { redirectTo }).mount('#login-app');
