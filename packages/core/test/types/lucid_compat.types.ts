import { BaseModel, column } from '@adonisjs/lucid/orm';
import type { QueryBuilderLike } from '../../src/lucid_adapter.js';

/**
 * Compile-time guard: a REAL `@adonisjs/lucid` query builder must be assignable
 * to {@link QueryBuilderLike}.
 *
 * This file is never executed and never bundled — `@adonisjs/lucid` is a
 * devDependency and nothing under `src/` imports it, so the package stays
 * framework-free where it counts. It exists only to be typechecked. Failing to
 * COMPILE is the failure signal.
 *
 * Why real Lucid instead of a hand-written stub: the bug this guards against was
 * originally chased with a transcribed stub of Lucid's `Where`/`WhereHas` types,
 * and the stub compiled clean while real Lucid did not. The stub was not a
 * faithful oracle, and there is no reason to think the next one would be. Only
 * Lucid's own `.d.ts` proves the seam.
 *
 * What broke, so the next reader doesn't re-derive it: `whereHas`'s relation
 * parameter must stay `any`. Lucid types it as `<Name extends
 * ExtractModelRelations<Model>>(relation: Name, ...)` — a union of the model's
 * literal relation names — and `string` is not assignable to that union under
 * the contravariant parameter check. Declaring `relation: string` makes every
 * real builder fail this file, and TS blames `where` (the first member it
 * tries), which is a red herring.
 */

class Author extends BaseModel {
  @column({ isPrimary: true })
  declare id: number;
}

class Post extends BaseModel {
  @column({ isPrimary: true })
  declare id: number;

  @column()
  declare title: string;

  @column()
  declare authorId: number;
}

/** Asserts `T` is exactly `true`; `Assert<false>` is a compile error. */
type Assert<T extends true> = T;

type PostBuilder = ReturnType<typeof Post.query>;
type AuthorBuilder = ReturnType<typeof Author.query>;

export type _PostBuilderIsASeam = Assert<PostBuilder extends QueryBuilderLike ? true : false>;
export type _AuthorBuilderIsASeam = Assert<AuthorBuilder extends QueryBuilderLike ? true : false>;

/**
 * The assignability that consuming apps actually exercise: passing a builder as
 * an argument. `extends` above and a parameter position relate types the same
 * way, but this is the shape the original failure took, so it is checked
 * directly rather than by proxy.
 */
declare function acceptsSeam(qb: QueryBuilderLike): void;

export function _passesRealBuilderByArgument(): void {
  acceptsSeam(Post.query());
  acceptsSeam(Author.query());
}

/**
 * The aggregation seam `applyGroupByCount` drives must exist on real builders with compatible
 * signatures — same proof as above, but `Required` (the members are optional on the seam so
 * minimal custom implementations can omit them).
 */
declare function needsAggSeam(
  qb: Required<Pick<QueryBuilderLike, 'select' | 'count' | 'groupBy' | 'offset'>>,
): void;

export function _passesAggSeamByArgument(): void {
  needsAggSeam(Post.query());
  needsAggSeam(Author.query());
}
