import type { FilterClientManifest } from './generate_client.js';

/** Where the app declares its `filters` manifest by default (`config/filter.ts`). */
export const DEFAULT_MANIFEST_ENTRYPOINT = 'config/filter.js';

/** Where `make:filter-client` writes the generated clients by default, relative to the app root. */
export const DEFAULT_CLIENT_OUTPUT = 'app/generated/filters';

/** The `codegen` options of `config/filter.ts`. */
export interface FilterCodegenConfig {
  /**
   * The directory `make:filter-client` writes the generated clients to and `agora:doctor` checks,
   * relative to the app root (or absolute). Default `app/generated/filters`.
   */
  output?: string;
}

/** Where the generated clients live, and whether `config/filter.ts` set it. */
export interface ClientOutput {
  path: string;
  configured: boolean;
}

/** The slice of the AdonisJS application {@link loadFilterManifest} reads. */
export interface ManifestApp {
  makeURL(...paths: string[]): URL;
  config?: { get<T>(key: string, fallback?: T): T };
}

/** What {@link loadFilterManifest} found. */
export type ManifestLoad =
  | {
      status: 'loaded';
      manifest: FilterClientManifest;
      entrypoint: string;
      /** The `codegen.output` of `config/filter.ts`, or the default. */
      output: ClientOutput;
    }
  | { status: 'missing'; entrypoint: string }
  | { status: 'empty'; entrypoint: string }
  | { status: 'failed'; entrypoint: string; error: string };

function isManifest(value: unknown): value is FilterClientManifest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.values(value as Record<string, unknown>);
  return (
    entries.length > 0 &&
    entries.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        typeof (entry as { spec?: { isFilterable?: unknown } }).spec?.isFilterable === 'function',
    )
  );
}

function isMissingModule(error: unknown, url: string): boolean {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown };
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false;
  const text = typeof message === 'string' ? message : '';
  const file = url.replace(/^file:\/\//, '').replace(/\.js$/, '');
  return text.includes(file) || text.includes(url);
}

function configuredOutput(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const output = (candidate as FilterCodegenConfig | undefined)?.output;
    if (typeof output === 'string' && output.trim() !== '') return output.trim();
  }
  return undefined;
}

/**
 * Load the app's `filters` manifest: the named `filters` export of `config/filter.ts`, its default
 * export (a manifest, or `{ filters }`), then `filters` in the `filter` config. The clients' output
 * directory is read the same way: a named `codegen` export, the default export's `codegen`, then
 * `codegen` in the `filter` config. The one loader
 * `make:filter-client`, the doctor and the dev tools share.
 */
export async function loadFilterManifest(
  app: ManifestApp,
  entrypoint = DEFAULT_MANIFEST_ENTRYPOINT,
): Promise<ManifestLoad> {
  const url = app.makeURL(entrypoint).href;
  let mod: Record<string, unknown> | undefined;
  try {
    mod = (await import(url)) as Record<string, unknown>;
  } catch (error) {
    if (!isMissingModule(error, url)) {
      return {
        status: 'failed',
        entrypoint,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const fromConfig = app.config?.get<{ filters?: unknown; codegen?: unknown } | undefined>(
    'filter',
    undefined,
  );
  const defaultExport = mod?.default as { filters?: unknown; codegen?: unknown } | undefined;
  const fromDefault = defaultExport?.filters;
  for (const candidate of [mod?.filters, mod?.default, fromDefault, fromConfig?.filters]) {
    if (isManifest(candidate)) {
      const configured = configuredOutput(
        mod?.codegen,
        defaultExport?.codegen,
        fromConfig?.codegen,
      );
      const output: ClientOutput =
        configured === undefined
          ? { path: DEFAULT_CLIENT_OUTPUT, configured: false }
          : { path: configured, configured: true };
      return { status: 'loaded', manifest: candidate, entrypoint, output };
    }
  }
  if (mod === undefined && fromConfig?.filters === undefined)
    return { status: 'missing', entrypoint };
  return { status: 'empty', entrypoint };
}
