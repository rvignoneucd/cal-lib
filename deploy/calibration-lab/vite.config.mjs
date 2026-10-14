import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({plugins:[react()],build:{outDir:'dist-calibration-lab',rolldownOptions:{input:'calibration-lab.html'}}})
