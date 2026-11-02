import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base must match the GitHub Pages sub-path: https://powpopow.github.io/split-app/
export default defineConfig({
  base: '/split-app/',
  plugins: [react()],
});
