import type { Dirent } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { ApplicationService } from '@adonisjs/core/types';
import {
  CONTENT_HASH_PREFIX,
  FILTER_CLIENT_BANNER,
  generateFilterClients,
  readFilterClientContentHash,
} from '../generate_client.js';
import { DEFAULT_CLIENT_OUTPUT, loadFilterManifest } from '../manifest.js';
import type { AgoraDoctorCheck, AgoraDoctorResult } from './agora_doctor.js';

const DOCS = 'https://davidecarvalho.github.io/agora/docs/filter';

export { DEFAULT_CLIENT_OUTPUT };

const CLIENT_FILE = /_filter_client\.ts$/;

/** Directories never searched for generated clients. */
const SKIPPED_DIRS = new Set([
  'node_modules',
  'build',
  'dist',
  'tmp',
  'coverage',
  'public',
  'storage',
  'vendor',
]);

/** How deep, and how many directories, the search for clients outside the output goes. */
const SEARCH_DEPTH = 6;
const SEARCH_DIR_BUDGET = 2000;

/**
 * Whether a file is a client `make:filter-client` wrote: its banner, anywhere in the file (like the
 * content hash, a license header a formatter adds above it must not hide it).
 */
function hasBanner(code: string): boolean {
  return code.split('\n').some((line) => line.trim() === FILTER_CLIENT_BANNER);
}

/**
 * The directories under the app root (outside `exclude`) that hold `*_filter_client.ts` files
 * carrying the generator's banner, as app-relative paths. Bounded: dot-dirs, build output and
 * `node_modules` are skipped, and the walk stops at {@link SEARCH_DEPTH} / {@link SEARCH_DIR_BUDGET}.
 */
export async function findClientDirs(root: string, exclude: string): Promise<string[]> {
  const found: string[] = [];
  let budget = SEARCH_DIR_BUDGET;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (budget-- <= 0 || dir === exclude) return;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    let isClientDir = false;
    for (const entry of entries) {
      if (isClientDir || !entry.isFile() || !CLIENT_FILE.test(entry.name)) continue;
      const code = await readOrNull(join(dir, entry.name));
      if (code !== null && hasBanner(code)) isClientDir = true;
    }
    if (isClientDir) found.push(relative(root, dir).split(sep).join('/') || '.');
    if (depth >= SEARCH_DEPTH) return;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || SKIPPED_DIRS.has(entry.name))
        continue;
      await walk(join(dir, entry.name), depth + 1);
    }
  };
  await walk(root, 0);
  return found.sort();
}

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
  const withoutHash = (code: string): string =>
    code
      .split('\n')
      .filter((line) => !line.trimStart().startsWith(CONTENT_HASH_PREFIX))
      .join('\n');
  return codeShape(withoutHash(onDisk)) === codeShape(withoutHash(fresh));
}

async function readOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function clientFilesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((file) => CLIENT_FILE.test(file)).sort();
  } catch {
    return [];
  }
}

/**
 * Compare the clients in `dir` (shown as `label`) with a fresh generation of the manifest.
 * `command` is the `make:filter-client` invocation that rewrites that directory.
 */
async function compareClients(
  manifest: Parameters<typeof generateFilterClients>[0],
  dir: string,
  label: string,
  onDisk: string[],
  command = 'node ace make:filter-client',
): Promise<AgoraDoctorResult> {
  let generated: ReturnType<typeof generateFilterClients>;
  try {
    generated = generateFilterClients(manifest);
  } catch (error) {
    return {
      status: 'error',
      message: `a spec cannot generate its client: ${error instanceof Error ? error.message : String(error)}`,
      docs: `${DOCS}/codegen`,
    };
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
    return { status: 'ok', message: `the clients in ${label} match the manifest` };
  }
  return {
    status: 'warn',
    message: `the generated clients in ${label} do not match config/filter.ts (${problems.join('; ')})`,
    fix: `Run \`${command}\`${orphaned.length > 0 ? ' and delete the files no longer in the manifest' : ''}`,
    docs: `${DOCS}/codegen`,
  };
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

        const output = load.output;
        const dir = isAbsolute(output.path) ? output.path : app.makePath(output.path);
        const inOutput = await clientFilesIn(dir);
        if (inOutput.length > 0) {
          results.push(await compareClients(load.manifest, dir, output.path, inOutput));
          return results;
        }

        if (output.configured) {
          results.push({
            status: 'warn',
            message: `codegen.output is ${output.path}, but it has no generated clients`,
            fix: 'Run `node ace make:filter-client`',
            docs: `${DOCS}/codegen`,
          });
          return results;
        }

        // Generated somewhere else with `--output` and no `codegen.output` to say where.
        const elsewhere = await findClientDirs(app.makePath(), dir);
        if (elsewhere.length === 0) {
          results.push({
            status: 'skip',
            message: `no generated clients in ${output.path} (or elsewhere in the app); set codegen.output in config/filter.ts if they live somewhere else`,
          });
          return results;
        }
        for (const found of elsewhere) {
          const foundDir = app.makePath(found);
          results.push(
            await compareClients(
              load.manifest,
              foundDir,
              found,
              await clientFilesIn(foundDir),
              `node ace make:filter-client --output ${found}`,
            ),
          );
        }
        results.push({
          status: 'warn',
          message: `generated clients are in ${elsewhere.join(', ')}, but config/filter.ts sets no codegen.output (default ${DEFAULT_CLIENT_OUTPUT})`,
          fix: `Set \`codegen: { output: '${elsewhere[0]}' }\` in config/filter.ts`,
          docs: `${DOCS}/codegen`,
        });
        return results;
      },
    },
  ];
}
