import { defineConfig } from 'vite';
export default defineConfig({ build: { rolldownOptions: { input: { main: 'index.html', coop: 'coop.html', economy: 'economy.html', lab: 'lab.html', testnet: 'testnet.html' } } } });
