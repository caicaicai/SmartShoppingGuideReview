import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // No proxy needed anymore as Vite runs WITHIN the backend server in dev mode
    hmr: {
        // Ensure HMR uses the correct port if running behind a different proxy (optional but good practice)
        // clientPort: 3000 
    }
  },
});