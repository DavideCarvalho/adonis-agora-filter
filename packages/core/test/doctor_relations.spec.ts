import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { checkRelations } from '../src/doctor/checks.js';
import { defineFilter, openRelationsRegistry } from '../src/filter_spec.js';

const SRC = pathToFileURL(join(import.meta.dirname, '..', 'src')).href;
const roots: string[] = [];

function fakeApp(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'filter-doctor-relations-'));
  roots.push(root);
  for (const [file, source] of Object.entries(files)) {
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return {
    root,
    app: {
      makePath: (...parts: string[]) => join(root, ...parts),
      makeURL: (...parts: string[]) => pathToFileURL(join(root, ...parts)),
      config: { get: (_key: string, fallback?: unknown) => fallback },
    } as never,
  };
}

beforeAll(() => {
  // defineFilter's dev warning is covered elsewhere; keep this output quiet.
  vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
});
afterAll(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('filter.relations doctor check', () => {
  it('skips when the app defines no specs', async () => {
    const results = await checkRelations(fakeApp().app);
    expect(results).toEqual([
      expect.objectContaining({
        status: 'skip',
        message: expect.stringContaining('no defineFilter'),
      }),
    ]);
  });

  it('is ok when every relation lists its columns', async () => {
    const { app } = fakeApp({
      'config/filter.js': `import { defineFilter } from '${SRC}/filter_spec.ts';
export const filters = { posts: { spec: defineFilter({ filterable: ['title'], relations: { author: { filterable: ['name'] } } }) } };`,
    });
    const results = await checkRelations(app);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ status: 'ok' });
  });

  it('warns for a spec in config/filter.ts with a relation declared without filterable, naming file and option', async () => {
    const { app } = fakeApp({
      'config/filter.js': `import { defineFilter } from '${SRC}/filter_spec.ts';
export const filters = {
  posts: { spec: defineFilter({ filterable: ['title'], relations: { author: {} } }) },
};`,
    });
    const results = await checkRelations(app);
    const warn = results.find(
      (r) => r.status === 'warn' && r.message.startsWith('config/filter.js:'),
    );
    expect(warn?.message).toMatch(
      /^config\/filter\.js:3: relation author declares no `filterable`/,
    );
    expect(warn?.fix).toContain("`relations.author.filterable: ['name']`");
    expect(warn?.docs).toContain('/definitions/relations');
  });

  it('loads the filter classes in app/filters and names the class', async () => {
    const { app } = fakeApp({
      'app/filters/nested/post_filter.js': `import { BaseModelFilter } from '${SRC}/base_model_filter.ts';
export default class PostFilter extends BaseModelFilter {
  static filterable = ['title'];
  static relations = { posts: { filterable: ['title'], relations: { comments: {} } } };
}`,
      'app/filters/broken.js': `throw new Error('needs a booted app')`,
    });
    const results = await checkRelations(app);
    const warn = results.find((r) => r.message.startsWith('filter class PostFilter'));
    expect(warn).toMatchObject({ status: 'warn' });
    expect(warn?.message).toContain('relation posts.comments declares');
    expect(warn?.fix).toContain('`relations.posts.relations.comments.filterable');
    const skipped = results.find((r) => r.status === 'skip');
    expect(skipped?.message).toContain('app/filters/broken.js (needs a booted app)');
  });

  it('records inline defineFilter calls by file and line, once per call site', () => {
    const before = openRelationsRegistry().entries.length;
    for (let i = 0; i < 3; i++) defineFilter({ filterable: ['a'], relations: { tags: {} } });
    const after = openRelationsRegistry();
    expect(after.entries).toHaveLength(before + 1);
    const entry = after.entries.at(-1);
    expect(entry?.origin).toMatch(/doctor_relations\.spec\.ts:\d+$/);
    expect(entry?.relations).toEqual(['tags']);
  });
});
