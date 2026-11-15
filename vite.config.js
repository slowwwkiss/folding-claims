import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works on GitHub Pages (/folding-claims/),
  // jsDelivr, or any static host without config changes.
  base: './',
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'es2022',
  },
});
