import { defineConfig } from 'vite';

export default defineConfig({
  base: '/The-Knight/',
  server: {
    host: true,
  },
  build: {
    target: 'es2020',
  },
});
