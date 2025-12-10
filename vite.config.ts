import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // Expose to all IPs
    allowedHosts: true, // Allow requests from any host header (needed for tunnels/nginx)
    hmr: {
        // HMR config, usually auto-detected but can be set if needed
    }
  },
});