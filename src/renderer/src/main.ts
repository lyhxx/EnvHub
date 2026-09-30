import { createApp } from 'vue'
import App from './App.vue'
import './styles.css'

// 首屏先用上次实际使用的明暗铺底，避免深色用户看到一闪而过的浅色（快照要等 IPC 回来才知道主题）。
if (window.localStorage.getItem('envhub.theme') === 'dark') document.documentElement.dataset.theme = 'dark'

createApp(App).mount('#app')
