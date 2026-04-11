import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/health':   'http://localhost:8000',
      '/login':    'http://localhost:8000',
      '/logout':   'http://localhost:8000',
      '/whoami':   'http://localhost:8000',
      '/projects': 'http://localhost:8000',
      '/ws':       { target: 'ws://localhost:8000', ws: true },
    },
  },
})
