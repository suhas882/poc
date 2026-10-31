import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    cssCodeSplit: true,
    sourcemap: false,
    // Inlined assets would need a data: CSP source; keep everything as files.
    assetsInlineLimit: 0
  },
  test: { globals: true, environment: 'jsdom' }
});
