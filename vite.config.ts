import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  // The third parameter '' ensures we load all env vars, not just VITE_*
  const env = loadEnv(mode, process.cwd(), '');
  
  // Check for API_KEY first, then fallback to GEMINI_API_KEY
  const apiKey = env.API_KEY || env.GEMINI_API_KEY || '';

  if (!apiKey) {
    console.warn("===============================================================");
    console.warn("⚠️  警告: 未检测到 API Key。");
    console.warn("请在项目根目录创建 .env 或 .env.local 文件");
    console.warn("并配置: API_KEY=你的Key  或者  GEMINI_API_KEY=你的Key");
    console.warn("===============================================================");
  }

  return {
    plugins: [react()],
    define: {
      // Inject the found key into the app as process.env.API_KEY
      // This allows the app code to stay consistent using process.env.API_KEY
      'process.env.API_KEY': JSON.stringify(apiKey),
    },
    server: {
      host: '0.0.0.0', 
      allowedHosts: true, 
    },
  };
});