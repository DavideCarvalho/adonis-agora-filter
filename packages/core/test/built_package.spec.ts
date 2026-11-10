import { existsSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AppFactory } from '@adonisjs/core/factories/app';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * These checks run against `dist/`, the files that actually ship, because both of the failures they
 * guard against only exist there: ace's `node ace add` looks for `configure` on the package's main
 * entry, and `make:filter` hands the copied `.stub` files to Tempura, which compiles them into a
 * JavaScript template literal. Turbo builds the package before `test`, so `dist/` is always fresh.
 */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(PACKAGE_ROOT, 'dist');
const SOURCE_STUBS = join(PACKAGE_ROOT, 'stubs');

function stubFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.stub'))
    .sort();
}

beforeAll(() => {
  if (!existsSync(join(DIST, 'src', 'index.js'))) {
    throw new Error('dist/ is missing: run `pnpm build` before the tests');
  }
});

describe('built package entry', () => {
  it('exports the configure hook that `node ace add` looks for', async () => {
    // Resolved through the package's own `exports` map, exactly as ace's `configure` command does.
    const entry = await import('@adonis-agora/filter');

    expect(typeof entry.configure).toBe('function');
  });

  it('wires the provider and the commands barrel from the main entry', async () => {
    const { configure } = await import('@adonis-agora/filter');
    const providers: string[] = [];
    const commands: string[] = [];
    const command = {
      async createCodemods() {
        return {
          async updateRcFile(callback: (rcFile: unknown) => void) {
            callback({
              addProvider: (specifier: string) => providers.push(specifier),
              addCommand: (specifier: string) => commands.push(specifier),
            });
          },
        };
      },
    };

    await configure(command as never);

    expect(providers).toEqual(['@adonis-agora/filter/filter_provider']);
    expect(commands).toEqual(['@adonis-agora/filter/commands']);
  });
});

describe('shipped stubs', () => {
  it('copies every source stub into dist', () => {
    expect(stubFiles(join(DIST, 'stubs'))).toEqual(stubFiles(SOURCE_STUBS));
  });

  it('compiles and renders every stub through the AdonisJS stub pipeline', async () => {
    const { stubsRoot } = (await import(pathToFileURL(join(DIST, 'stubs', 'main.js')).href)) as {
      stubsRoot: string;
    };
    const app = new AppFactory().create(pathToFileURL(join(PACKAGE_ROOT, 'tmp', 'app/')), () => {});
    await app.init();
    const stubs = await app.stubs.create();

    const files = stubFiles(stubsRoot);
    expect(files.length).toBeGreaterThan(0);

    const rendered = new Map<string, { destination: string; contents: string }>();
    for (const file of files) {
      const stub = await stubs.build(file, { source: stubsRoot });
      const prepared = await stub.prepare({
        entity: app.generators.createEntity('user'),
        flags: {},
      });

      expect(prepared.contents, file).not.toContain('{{');
      rendered.set(file.split(sep).join('/'), prepared);
    }

    const filter = rendered.get('make/filter/main.stub');
    expect(filter?.destination).toBe(app.makePath('app/filters/user_filter.ts'));
    expect(filter?.contents).toContain('export default class UserFilter extends BaseModelFilter');
    expect(filter?.contents).toContain("import User from '#models/user'");
  });
});
