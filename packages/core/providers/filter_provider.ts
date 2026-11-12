import type { ApplicationService } from '@adonisjs/core/types';
import { registerFilterDevTools } from '../src/dev_tools/tools.js';
import { registerDoctorChecks } from '../src/doctor/agora_doctor.js';
import { filterDoctorChecks } from '../src/doctor/checks.js';
import { registerFilterMacros } from '../src/lucid_macros.js';
import { loadFilterManifest } from '../src/manifest.js';

/**
 * Wires `@adonis-agora/filter`'s chainable Lucid macros into the application.
 *
 * On boot it registers the `applyFilterFromRequest` and `filterPaginate` macros
 * onto Lucid's `ModelQueryBuilder`, so any model query gains the method-call form
 * of the free `applyFilterFromRequest` helper:
 *
 * ```ts
 * const rows = await User.query()
 *   .where('tenantId', tenant.id)
 *   .applyFilterFromRequest(userFilter, ctx)
 *   .orderBy('createdAt', 'desc')
 *
 * const page = await User.query().filterPaginate(userFilter, ctx)
 * ```
 *
 * It also registers the `agora:doctor` checks, and the filter developer tools on `@adonis-agora/agent`'s dev MCP endpoint when
 * that is installed.
 *
 * Register it in `adonisrc.ts` (`providers`). The free functions
 * (`applyFilterFromRequest`, `applyCursorFromRequest`) work without it — this
 * provider only adds the chainable sugar, so `@adonisjs/lucid` is loaded lazily
 * here (not a hard dependency of the package).
 */
export default class FilterProvider {
  constructor(protected app: ApplicationService) {}

  async boot() {
    await registerDoctorChecks(this.app.container as never, filterDoctorChecks());
    const { ModelQueryBuilder } = await import('@adonisjs/lucid/orm');
    registerFilterMacros(ModelQueryBuilder);
    await this.#registerDevTools();
  }

  /**
   * Registers the filter developer tools on `@adonis-agora/agent`'s dev MCP endpoint
   * (`/mcp/agora`) when it is installed. They read the `filters` manifest of config/filter.ts at
   * call time.
   */
  async #registerDevTools() {
    const container = this.app.container as { hasBinding?: (binding: string) => boolean };
    if (typeof container.hasBinding !== 'function') return;
    if (this.app.config.get<{ devTools?: boolean } | undefined>('filter', {})?.devTools === false) {
      return;
    }
    const outcome = await registerFilterDevTools(this.app.container as never, {
      manifest: () => loadFilterManifest(this.app),
    });
    if (outcome === 'unsupported' || outcome === 'failed') {
      const logger = (await this.app.container.make('logger').catch(() => undefined)) as
        | { debug(msg: string): void }
        | undefined;
      logger?.debug(
        outcome === 'unsupported'
          ? '[@adonis-agora/filter] dev tools not registered: the installed @adonis-agora/agent cannot gate libs without a console (needs devTools.authorize support)'
          : '[@adonis-agora/filter] dev tools could not be registered',
      );
    }
  }
}
