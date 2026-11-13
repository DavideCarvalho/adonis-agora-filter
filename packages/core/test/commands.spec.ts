import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AceFactory } from '@adonisjs/core/factories/core/ace';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import loader from '../commands/main.js';
import { FilterQueryExplain, FilterSpecsList, FilterSpecsShow } from '../commands/specs.js';
import { defineFilter } from '../src/filter_spec.js';
import type { FilterClientManifest } from '../src/generate_client.js';

type Kernel = Awaited<ReturnType<typeof AceFactory.prototype.make>>;
type Logs = { getLogs(): { message: string; stream: string }[] };

const people = defineFilter({
  filterable: ['name', 'age'],
  sortable: ['name', 'age'],
  searchable: ['name'],
  relations: { posts: { filterable: ['title'] } },
  fieldTypes: { age: { kind: 'number' } },
  aliases: { years: 'age' },
  maxSize: 50,
  tenant: { column: 'tenantId', resolve: () => 't1' },
});
const tags = defineFilter({ filterable: ['label'], throwOnInvalid: true });
const manifest: FilterClientManifest = {
  people: { spec: people },
  tags: { spec: tags },
};

describe('filter commands', () => {
  let appRoot: string;

  beforeEach(async () => {
    appRoot = await mkdtemp(join(tmpdir(), 'filter-commands-'));
    await writeFile(
      join(appRoot, 'adonisrc.ts'),
      `import { defineConfig } from '@adonisjs/core/app'\nexport default defineConfig({})\n`,
    );
  });

  afterEach(async () => {
    await rm(appRoot, { recursive: true, force: true });
  });

  /** `null`: no `filter` config at all. */
  async function ace(filters: unknown): Promise<Kernel> {
    const kernel = await new AceFactory().make(pathToFileURL(`${appRoot}/`), {
      importer: (filePath) => import(filePath),
    });
    await kernel.app.init();
    await kernel.app.boot();
    if (filters !== null) kernel.app.config.set('filter', { filters });
    kernel.ui.switchMode('raw');
    return kernel;
  }

  async function exec(command: unknown, argv: string[], filters: unknown = manifest) {
    const kernel = await ace(filters);
    const instance = await kernel.create(command as never, argv);
    await instance.exec();
    return instance;
  }

  function printed(instance: { logger: Logs }): string {
    return instance.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
  }

  function output(instance: { ui: { logger: Logs } }): string {
    return instance.ui.logger
      .getLogs()
      .map((l) => l.message)
      .join('\n');
  }

  it('registers the read commands next to make:* and the doctor', async () => {
    const names = (await loader.getMetaData()).map((c) => c.commandName).sort();
    expect(names).toEqual([
      'agora:doctor',
      'filter:doctor',
      'filter:query:explain',
      'filter:specs:list',
      'filter:specs:show',
      'make:filter',
      'make:filter-client',
    ]);
  });

  describe('filter:specs:list', () => {
    it('prints a table of the specs', async () => {
      const cmd = await exec(FilterSpecsList, []);
      expect(cmd.exitCode).toBe(0);
      const text = output(cmd);
      expect(text).toContain('people');
      expect(text).toContain('tags');
    });

    it('--json prints the { data, meta } list format, paged', async () => {
      const cmd = await exec(FilterSpecsList, ['--json', '--size=1', '--page=2']);
      const body = JSON.parse(printed(cmd));
      expect(body.data).toEqual([
        {
          name: 'tags',
          filterable: 1,
          sortable: 1,
          searchable: [],
          relations: [],
          tenantScoped: false,
        },
      ]);
      expect(body.meta).toEqual({
        total: 2,
        perPage: 1,
        currentPage: 2,
        lastPage: 2,
        firstPage: 1,
      });
    });

    it('fails with exit code 1 when there is no manifest', async () => {
      const cmd = await exec(FilterSpecsList, [], null);
      expect(cmd.exitCode).toBe(1);
      expect(printed(cmd)).toContain('filters');
    });

    it('refuses a bad --size', async () => {
      const cmd = await exec(FilterSpecsList, ['--size=0']);
      expect(cmd.exitCode).toBe(1);
      expect(printed(cmd)).toContain('--size');
    });
  });

  describe('filter:specs:show', () => {
    it('prints one spec', async () => {
      const cmd = await exec(FilterSpecsShow, ['people']);
      expect(cmd.exitCode).toBe(0);
      const text = output(cmd);
      expect(text).toContain('posts.title');
      expect(text).toContain('tenantId');
      expect(text).toContain('years → age');
    });

    it('--json prints the spec as the MCP tool returns it', async () => {
      const cmd = await exec(FilterSpecsShow, ['people', '--json']);
      const body = JSON.parse(printed(cmd));
      expect(body.name).toBe('people');
      expect(body.filterablePaths).toEqual(['name', 'age', 'posts.title']);
      expect(body.tenantColumn).toBe('tenantId');
      expect(body.clientFieldTypes).toEqual({});
    });

    it('fails with exit code 1 on an unknown spec', async () => {
      const cmd = await exec(FilterSpecsShow, ['nope']);
      expect(cmd.exitCode).toBe(1);
      expect(printed(cmd)).toContain('No spec "nope". Known: people, tags');
    });
  });

  describe('filter:query:explain', () => {
    it('prints the parsed request and the builder calls', async () => {
      const cmd = await exec(FilterQueryExplain, ['people', 'filter[name][contains]=Al&sort=-age']);
      expect(cmd.exitCode).toBe(0);
      expect(printed(cmd)).toContain('Accepted by "people"');
      expect(output(cmd)).toContain('-age');
      expect(printed(cmd)).toContain('Query builder calls');
    });

    it('--json prints the explanation; a refused request exits with 1', async () => {
      const cmd = await exec(FilterQueryExplain, ['tags', 'filter[secret][equals]=x', '--json']);
      expect(cmd.exitCode).toBe(1);
      const body = JSON.parse(printed(cmd));
      expect(body.spec).toBe('tags');
      expect(body.rejected).toBe(true);
      expect(body.issues[0]).toMatchObject({ part: 'filter', subject: 'secret' });
    });

    it('lists dropped filters', async () => {
      const cmd = await exec(FilterQueryExplain, ['people', 'filter[secret][equals]=x']);
      expect(cmd.exitCode).toBe(0);
      expect(output(cmd)).toContain('dropped');
    });

    it('fails with exit code 1 on an unknown spec', async () => {
      const cmd = await exec(FilterQueryExplain, ['nope', 'sort=name']);
      expect(cmd.exitCode).toBe(1);
      expect(printed(cmd)).toContain('No spec "nope"');
    });
  });
});
