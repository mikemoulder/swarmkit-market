import { createEconomy, advanceEconomy, economyView, configureAgent } from './economy.mjs';

export function marketController(store) {
  return {
    async read() {
      const { value } = await store.read();
      return value ? economyView(value) : null;
    },
    async command(command, configuration = {}) {
      return store.lock(async () => {
        let { value, revision } = await store.read();
        const save = async state => { revision = await store.write(state, revision); };
        if (command === 'create' && value) return economyView(value);
        if (command === 'create' || command === 'reset') {
          value = createEconomy(configuration); await save(value);
        } else {
          if (!value) throw new Error('Create a market first');
          if (command === 'configure-agent') { value = configureAgent(value, configuration); await save(value); }
          else {
            if (!['advance', 'resume'].includes(command)) throw new Error('Unknown market command');
            value = await advanceEconomy(value, save, { resume: command === 'resume' });
          }
        }
        return economyView(value);
      });
    },
  };
}
