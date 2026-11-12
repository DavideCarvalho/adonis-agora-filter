import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import {
  CONTENT_HASH_PREFIX,
  generateFilterClients,
  readFilterClientContentHash,
} from '../generate_client.js';
import { loadFilterManifest } from '../manifest.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/filter';

/** Where `make:filter-client` writes by default, relative to the app root. */
export const DEFAULT_CLIENT_OUTPUT = 'app/generated/filters';

const CLIENT_FILE = /_filter_client\.ts$/;

/**
 * The code with formatting erased outside string literals (whitespace, semicolons, commas, quote
 * style and escapes, quotes around identifier-like object keys, a union's leading `|`), so a
 * client the app ran its formatter over still compares equal to a fresh generation, while any
 * change inside a string literal still counts. Only the fallback for clients generated before the
 * banner carried a content hash (see {@link clientMatches}).
 */
export function codeShape(code: string): string {
  let out = '';
  let quote: string | null = null;
  let literalStart = 0;
  let comment: 'line' | 'block' | null = null;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i] as string;
    const next = code[i + 1];
    if (comment === 'line') {
      if (ch === '\n') comment = null;
      else if (!/\s/.test(ch)) out += ch;
      continue;
    }
    if (comment === 'block') {
      if (ch === '*' && next === '/') {
        comment = null;
        out += '*/';
        i++;
      } else if (!/\s/.test(ch)) out += ch;
      continue;
    }
    if (quote !== null) {
      if (ch === '\\') {
        // `\'` and `\"` are the same character whichever quote the formatter picked.
        out += next === "'" || next === '"' ? next : ch + (next ?? '');
        i++;
      } else if (ch === quote) {
        const content = out.slice(literalStart + 1);
        // `{ "age": 1 }` and `{ age: 1 }` are the same object (prettier's quoteProps).
        if (
          quote !== '`' &&
          /^[A-Za-z_$][\w$]*$/.test(content) &&
          /^\s*:/.test(code.slice(i + 1))
        ) {
          out = out.slice(0, literalStart) + content;
        } else {
          out += quote === '`' ? '`' : "'";
        }
        quote = null;
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      comment = 'line';
      out += '//';
      i++;
    } else if (ch === '/' && next === '*') {
      comment = 'block';
      out += '/*';
      i++;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      literalStart = out.length;
      out += ch === '`' ? '`' : "'";
    } else if (ch === '|' && next !== '|' && /[=(<:]$/.test(out)) {
      // A union broken over lines gains a leading `|` (`type X =\n  | 'a'\n  | 'b'`).
    } else if (!/\s/.test(ch) && ch !== ';' && ch !== ',') {
      out += ch;
    }
  }
  return out;
}

/**
 * Whether a generated client on disk still matches a fresh generation. Clients carry the hash of
 * what the generator emitted in their banner (a line comment no formatter touches), so the hashes
 * are compared and any reformatting of the code is irrelevant. A client without the hash (written
 * before it existed, or with `banner: false`) falls back to comparing {@link codeShape}s.
 */
export function clientMatches(onDisk: string, fresh: string): boolean {
  const hash = readFilterClientContentHash(onDisk);
  const expected = readFilterClientContentHash(fresh);
  if (hash !== null && expected !== null) return hash === expected;
  const withoutHash = fresh
    .split('\n')
    .filter((line) => !line.trimStart().startsWith(CONTENT_HASH_PREFIX))
    .join('\n');
  return codeShape(onDisk) === codeShape(withoutHash);
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
          else if (!clientMatches(current, client.code)) stale.push(client.filename);
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
