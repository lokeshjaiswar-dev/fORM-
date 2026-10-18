import { defineJob } from './define.ts';

/**
 * Stub (WP-0.14): the queue, singleton policy and boot-time enqueue are real, but this build has no system pack.
 * WP-T0.3 builds the signed pack and the templates WPs seed it as `fr_template_seeder`.
 */
export const templatesSeed = defineJob({
  name: 'templates.seed',
  perms: [],
  async run({ log }) {
    log.info({ packs: 0 }, 'templates.seed: no system template packs in this build');
  },
});
