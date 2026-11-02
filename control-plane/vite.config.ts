import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

// UI dibangun ke web/dist lalu disajikan control plane dari origin yang sama (cookie sesi + cek Origin)
export default defineConfig({
  root: 'web',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': fileURLToPath(new URL('./web/src', import.meta.url)) } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 700 },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/auth': 'http://localhost:3000', '/health': 'http://localhost:3000' },
  },
})
