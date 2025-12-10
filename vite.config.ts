import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // Expose to all IPs
    allowedHosts: true, // Allow requests from any host header (needed for tunnels/nginx)
    hmr: {
        // Vital for Nginx HTTPS proxying:
        // Tells the client (browser) to connect via standard HTTPS port (443)
        // instead of trying to hit the backend port directly.
        clientPort: 443 
    }
  },
});