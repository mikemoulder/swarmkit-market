import { defineConfig } from 'vite';
export default defineConfig({ build: { rolldownOptions: { input: { main: 'index.html', testnet: 'testnet.html' } } } });
