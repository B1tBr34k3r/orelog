import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const repositoryName = process.env.GITHUB_REPOSITORY?.split('/')[1]
const pagesBase = repositoryName && !repositoryName.endsWith('.github.io') ? `/${repositoryName}/` : '/'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.GITHUB_REPOSITORY ? pagesBase : '/',
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/healthz': 'http://127.0.0.1:3000',
    },
  },
})
