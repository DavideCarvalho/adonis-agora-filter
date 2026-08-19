import type Configure from '@adonisjs/core/commands/configure';

/**
 * `node ace add @adonis-agora/filter` (or `node ace configure @adonis-agora/filter`)
 * — auto-wires the package into an AdonisJS app:
 *
 * 1. registers the service provider in `adonisrc.ts`, which installs the
 *    chainable `applyFilterFromRequest` / `filterPaginate` Lucid macros;
 * 2. registers the ace commands barrel, which is what makes `make:filter-client`
 *    show up in `node ace list`.
 *
 * There is no config file to publish: a filter policy is a per-model
 * `defineFilterSpec` call in your own code, not global configuration.
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/filter/filter_provider');
    rcFile.addCommand('@adonis-agora/filter/commands');
  });
}
