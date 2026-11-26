import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { officeApiPlugin } from './server/office-api.ts';

export default defineConfig({
  plugins: [solid(), officeApiPlugin()],
  server: { host: '127.0.0.1', port: 3010, strictPort: true, cors: false, fs: { strict: true } },
  preview: { host: '127.0.0.1', port: 3010, strictPort: true, cors: false },
  build: {
    target: 'es2022', sourcemap: false,
    rolldownOptions: { output: { codeSplitting: { groups: [{ name: 'three', test: /node_modules[\\/]three/ }] } } },
  },
});
