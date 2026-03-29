import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const backend = process.env.BACKEND_URL || 'http://127.0.0.1:3001'
const backendWs = backend.replace(/^http/, 'ws')

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': backend,
      '/ws': { target: backendWs, ws: true },
    },
  },
})
