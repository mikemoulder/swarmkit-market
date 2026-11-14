import { defineConfig } from 'vite';
export default defineConfig({ build: { rolldownOptions: { input: { main: 'index.html', economy: 'economy.html', lab: 'lab.html', testnet: 'testnet.html' } } } });
