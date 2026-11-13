import { args, BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import {
  explainFilterSpecQuery,
  type FilterDevToolsDeps,
  getFilterSpec,
  listFilterSpecs,
} from '../src/dev_tools/tools.js';
import { offsetPage } from '../src/list_api.js';
import { loadFilterManifest } from '../src/manifest.js';

/**
 * Base for the `filter:*` read commands: boots the app (no server), reads the `filters` manifest
 * through the same loader `make:filter-client`, the doctor and the dev tools use, and turns a
 * refused input (unknown spec, unreadable manifest, bad flag) into one error line and exit code 1.
 */
abstract class FilterCommand extends BaseCommand {
  static override options: CommandOptions = { startApp: true };

  override async completed() {
    const error = this.error as unknown;
    if (
      error instanceof Error &&
      !(error instanceof TypeError) &&
      !(error instanceof ReferenceError) &&
      !(error instanceof SyntaxError)
    ) {
      this.logger.error(error.message);
      this.exitCode = 1;
      return true;
    }
    return false;
  }

  protected deps(): FilterDevToolsDeps {
    return { manifest: () => loadFilterManifest(this.app) };
  }

  protected printJson(value: unknown): void {
    this.logger.log(JSON.stringify(value, null, 2));
  }
}

function positiveInt(value: number | undefined, fallback: number, flag: string, max?: number) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || (max !== undefined && value > max)) {
    throw new Error(
      `--${flag} must be an integer of at least 1${max !== undefined ? ` and at most ${max}` : ''}`,
    );
  }
  return value;
}

function list(values: readonly unknown[]): string {
  return values.length === 0 ? '' : values.map(String).join(', ');
}

/** `node ace filter:specs:list [--page=1] [--size=50] [--json]` — the specs of the manifest. */
export class FilterSpecsList extends FilterCommand {
  static override commandName = 'filter:specs:list';
  static override description = 'List the filter specs of the `filters` manifest';

  @flags.number({ description: 'Page number, from 1 (default 1)' })
  declare page?: number;

  @flags.number({ description: 'Specs per page (default 50, at most 500)' })
  declare size?: number;

  @flags.boolean({ description: 'Print JSON ({ data, meta })' })
  declare json?: boolean;

  override async run(): Promise<void> {
    const page = positiveInt(this.page, 1, 'page');
    const size = positiveInt(this.size, 50, 'size', 500);
    const { items, hint } = await listFilterSpecs(this.deps());
    if (hint !== undefined) throw new Error(hint);
    const rows = items.slice((page - 1) * size, page * size);
    if (this.json) return this.printJson(offsetPage(rows, { total: items.length, page, size }));
    if (rows.length === 0) {
      this.logger.info(items.length === 0 ? 'No specs.' : `No specs on page ${page}.`);
      return;
    }
    const table = this.ui.table();
    table.head(['Spec', 'Filterable', 'Sortable', 'Searchable', 'Relations', 'Tenant scoped']);
    for (const spec of rows) {
      table.row([
        spec.name,
        String(spec.filterable),
        String(spec.sortable),
        list(spec.searchable),
        list(spec.relations),
        spec.tenantScoped ? 'yes' : 'no',
      ]);
    }
    table.render();
    if (page * size < items.length) {
      this.logger.info(`${items.length} specs; next page: --page=${page + 1}`);
    }
  }
}

/** `node ace filter:specs:show <name> [--json]` — one spec in full. */
export class FilterSpecsShow extends FilterCommand {
  static override commandName = 'filter:specs:show';
  static override description = 'Show one filter spec in full';

  @args.string({ description: 'The spec name (a key of the `filters` manifest)' })
  declare name: string;

  @flags.boolean({ description: 'Print JSON' })
  declare json?: boolean;

  override async run(): Promise<void> {
    const spec = await getFilterSpec(this.deps(), this.name);
    if (this.json) return this.printJson(spec);
    const table = this.ui.table();
    table.head(['Field', 'Value']);
    table.row(['Spec', spec.name]);
    table.row([
      'Filterable',
      spec.filterable === '*' ? '* (any column)' : list(spec.filterablePaths),
    ]);
    table.row(['Sortable', spec.sortable === '*' ? '* (any column)' : list(spec.sortablePaths)]);
    table.row(['Searchable', list(spec.searchable)]);
    const fullText = spec.fullText?.column;
    table.row(['Full text', typeof fullText === 'string' ? fullText : list(fullText ?? [])]);
    table.row(['Relations', list(Object.keys(spec.relations))]);
    table.row(['Max depth', spec.maxDepth === undefined ? '' : String(spec.maxDepth)]);
    table.row([
      'Field types',
      list(
        Object.entries(spec.fieldTypes).map(
          ([field, type]) => `${field}: ${(type as { kind?: string }).kind ?? '?'}`,
        ),
      ),
    ]);
    table.row([
      'Aliases',
      list(Object.entries(spec.aliases).map(([alias, field]) => `${alias} → ${field}`)),
    ]);
    table.row(['Computed', list(Object.keys(spec.computed))]);
    table.row(['Tenant column', spec.tenantColumn ?? '']);
    table.row(['Default filters', String(spec.defaultFilters.length)]);
    table.row([
      'Default sort',
      list(spec.defaultSort.map((s) => `${s.direction === 'desc' ? '-' : ''}${s.field}`)),
    ]);
    table.row(['Default size', spec.defaultSize === null ? '' : String(spec.defaultSize)]);
    table.row(['Max size', spec.maxSize === null ? '' : String(spec.maxSize)]);
    table.row(['Throw on invalid', spec.throwOnInvalid ? 'yes' : 'no']);
    table.row(['Operators', list(spec.operators)]);
    table.render();
  }
}

/**
 * `node ace filter:query:explain <name> <query> [--json]` — dry-run a query string against a spec,
 * with no database. Exits with 1 when the request would be refused.
 */
export class FilterQueryExplain extends FilterCommand {
  static override commandName = 'filter:query:explain';
  static override description = 'Dry-run a query string against a filter spec (no database)';

  @args.string({ description: 'The spec name (a key of the `filters` manifest)' })
  declare name: string;

  @args.string({ description: "The query string, e.g. 'filter[name][contains]=Al&sort=-age'" })
  declare query: string;

  @flags.boolean({ description: 'Print JSON' })
  declare json?: boolean;

  override async run(): Promise<void> {
    const out = await explainFilterSpecQuery(this.deps(), this.name, this.query);
    if (out.rejected) this.exitCode = 1;
    if (this.json) return this.printJson(out);

    if (out.rejected) this.logger.error(`Refused: ${out.rejection}`);
    else this.logger.success(`Accepted by "${out.spec}".`);

    const parsed = this.ui.table();
    parsed.head(['Part', 'Value']);
    for (const filter of out.parsed.filters ?? []) {
      parsed.row(['filter', JSON.stringify(filter)]);
    }
    for (const sort of out.parsed.sort ?? []) {
      parsed.row(['sort', `${sort.direction === 'desc' ? '-' : ''}${sort.field}`]);
    }
    if (out.parsed.search !== undefined) parsed.row(['search', out.parsed.search]);
    for (const field of out.parsed.distinct ?? []) parsed.row(['distinct', field]);
    if (out.pagination) {
      parsed.row(['page', String(out.pagination.page)]);
      parsed.row(['size', String(out.pagination.size)]);
    }
    if (out.serverScope.tenantColumn) {
      parsed.row(['tenant column (server)', out.serverScope.tenantColumn]);
    }
    if (out.serverScope.defaultFilters.length > 0) {
      parsed.row(['default filters (server)', JSON.stringify(out.serverScope.defaultFilters)]);
    }
    parsed.render();

    if (out.issues.length > 0) {
      const issues = this.ui.table();
      issues.head(['Part', 'Subject', 'Effect', 'Why']);
      for (const issue of out.issues) {
        issues.row([issue.part, issue.subject, issue.effect, issue.message]);
      }
      issues.render();
    }

    if (out.calls.length > 0) {
      this.logger.log(this.colors.bold('Query builder calls'));
      for (const call of out.calls) {
        this.logger.log(`  ${call.method}(${call.args.map((a) => JSON.stringify(a)).join(', ')})`);
      }
    }
  }
}
