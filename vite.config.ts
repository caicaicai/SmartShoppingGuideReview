import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '');
  
  const apiKey = env.API_KEY || '';

  if (!apiKey) {
    console.warn("===============================================================");
    console.warn("⚠️  警告: 未检测到 API_KEY 环境变量。");
    console.warn("请在项目根目录创建 .env 文件，并写入: API_KEY=你的GeminiKey");
    console.warn("===============================================================");
  }

  return {
    plugins: [react()],
    define: {
      // Safely stringify the key (or empty string) to prevent 'undefined' in code
      'process.env.API_KEY': JSON.stringify(apiKey),
    },
    server: {
      host: '0.0.0.0', 
      allowedHosts: true, 
    },
  };
});