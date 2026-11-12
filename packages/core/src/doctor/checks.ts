import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import { generateFilterClients } from '../generate_client.js';
import { loadFilterManifest } from '../manifest.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/filter';

/** Where `make:filter-client` writes by default, relative to the app root. */
export const DEFAULT_CLIENT_OUTPUT = 'app/generated/filters';

const CLIENT_FILE = /_filter_client\.ts$/;

/**
 * The code with formatting erased (whitespace, semicolons, commas, quote style), so a client the app
 * ran its formatter over still compares equal to a fresh generation.
 */
export function codeShape(code: string): string {
  return code.replace(/\s+/g, '').replace(/[;,]/g, '').replace(/"/g, "'");
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** The doctor checks of `@adonis-agora/filter` (ids frozen for 1.x). */
export function filterDoctorChecks(): AgoraDoctorCheck[] {
  return [
    {
      id: 'filter.manifest',
      lib: 'filter',
      title: 'Filter specs and generated clients',
      async run(app: ApplicationService): Promise<AgoraDoctorResult[]> {
        const load = await loadFilterManifest(app);
        if (load.status === 'missing') {
          return [{ status: 'skip', message: 'no config/filter.ts manifest' }];
        }
        if (load.status === 'failed') {
          return [
            {
              status: 'error',
              message: `config/filter.ts failed to load: ${load.error}`,
              fix: 'Fix the error in config/filter.ts (a defineFilter call throws on a bad spec)',
              docs: `${DOCS}/codegen`,
            },
          ];
        }
        if (load.status === 'empty') {
          return [
            {
              status: 'warn',
              message: 'config/filter.ts exports no `filters` manifest of defineFilter specs',
              fix: 'Export `filters: FilterClientManifest` from config/filter.ts, or delete the file',
              docs: `${DOCS}/codegen`,
            },
          ];
        }

        const names = Object.keys(load.manifest);
        const results: AgoraDoctorResult[] = [
          { status: 'ok', message: `${names.length} spec(s): ${names.sort().join(', ')}` },
        ];

        const dir = app.makePath(DEFAULT_CLIENT_OUTPUT);
        let onDisk: string[];
        try {
          onDisk = (await readdir(dir)).filter((file) => CLIENT_FILE.test(file));
        } catch {
          return results;
        }
        if (onDisk.length === 0) return results;

        let generated: ReturnType<typeof generateFilterClients>;
        try {
          generated = generateFilterClients(load.manifest);
        } catch (error) {
          results.push({
            status: 'error',
            message: `a spec cannot generate its client: ${error instanceof Error ? error.message : String(error)}`,
            docs: `${DOCS}/codegen`,
          });
          return results;
        }
        const stale: string[] = [];
        const missing: string[] = [];
        for (const client of generated) {
          const current = await readOrNull(join(dir, client.filename));
          if (current === null) missing.push(client.filename);
          else if (codeShape(current) !== codeShape(client.code)) stale.push(client.filename);
        }
        const expected = new Set(generated.map((client) => client.filename));
        const orphaned = onDisk.filter((file) => !expected.has(file));
        const problems = [
          ...(stale.length > 0 ? [`out of date: ${stale.join(', ')}`] : []),
          ...(missing.length > 0 ? [`missing: ${missing.join(', ')}`] : []),
          ...(orphaned.length > 0 ? [`no longer in the manifest: ${orphaned.join(', ')}`] : []),
        ];
        if (problems.length === 0) {
          results.push({
            status: 'ok',
            message: `the clients in ${DEFAULT_CLIENT_OUTPUT} match the manifest`,
          });
        } else {
          results.push({
            status: 'warn',
            message: `the generated clients in ${DEFAULT_CLIENT_OUTPUT} do not match config/filter.ts (${problems.join('; ')})`,
            fix: `Run \`node ace make:filter-client\`${orphaned.length > 0 ? ' and delete the files no longer in the manifest' : ''}`,
            docs: `${DOCS}/codegen`,
          });
        }
        return results;
      },
    },
  ];
}
