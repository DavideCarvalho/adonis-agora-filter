/**
 * The slice of Lucid's `ModelQueryBuilder` that {@link paginate} drives, declared structurally so
 * this module never hard-imports `@adonisjs/lucid`. Anything without it (a test double, a custom
 * builder) is paged through its own `paginate`.
 */
interface LucidModelQuery {
  paginate(page: number, perPage: number): unknown;
  clone(): LucidModelQuery;
  clearOrder(): LucidModelQuery;
  clearLimit(): LucidModelQuery;
  clearOffset(): LucidModelQuery;
  clearSelect(): LucidModelQuery;
  count(column: string): LucidModelQuery;
  pojo(): LucidModelQuery;
  forPage(page: number, perPage: number): LucidModelQuery;
  exec(): Promise<Array<{ total: unknown }>>;
  execQuery(): Promise<unknown[]>;
  hasGroupBy: boolean;
  wrapResultsToModelInstances: boolean;
  knexQuery: { _method?: string; _statements?: KnexStatement[] };
  model: {
    namingStrategy: unknown;
    $hooks: {
      has(event: string): boolean;
      runner(event: string): { run(...args: unknown[]): Promise<void> };
    };
  };
}

interface KnexStatement {
  grouping: string;
  type?: string;
  distinct?: boolean;
  distinctOn?: boolean;
  value?: unknown;
}

/**
 * Lucid counts the query with its select list cleared, so the page has as many rows as the count
 * only while the select list cannot change how many rows come back: plain columns and scalar
 * subqueries (`withCount`). A `distinct`, an aggregate, a raw expression or a `union` can, and
 * then the page does not pin Lucid's total.
 */
function selectKeepsRowCount(statements: KnexStatement[] | undefined): boolean {
  if (!statements) return false;
  return statements.every((statement) => {
    if (statement.grouping === 'union') return false;
    if (statement.grouping !== 'columns') return true;
    if (statement.distinct || statement.distinctOn || statement.type !== undefined) return false;
    return (
      Array.isArray(statement.value) &&
      statement.value.every(
        (column) =>
          typeof column === 'string' ||
          (typeof column === 'object' &&
            column !== null &&
            !(column as { isRawInstance?: boolean }).isRawInstance),
      )
    );
  });
}

function isLucidModelQuery(query: object): query is LucidModelQuery {
  const q = query as Partial<LucidModelQuery>;
  return (
    typeof q.forPage === 'function' &&
    typeof q.execQuery === 'function' &&
    typeof q.clone === 'function' &&
    typeof q.model?.$hooks?.has === 'function'
  );
}

/**
 * Lucid's `query.paginate(page, perPage)`, fetching the page before the total.
 *
 * Lucid counts every matching row before it reads the page. A page that comes back shorter than
 * `perPage` already pins the total (`offset + rows`), so the count runs only for a full page, or
 * an empty page past the first. Same paginator class, same meta, same `after:*` hooks. A model
 * with a `before:paginate` or `before:fetch` hook is left to Lucid, since those hooks may change
 * the count query and the page query differently; so is a select list that changes the row count
 * (see {@link selectKeepsRowCount}).
 */
export function paginate(query: object, page: number, perPage: number): unknown {
  const q = query as LucidModelQuery;
  page = Number(page);
  perPage = Number(perPage);
  if (
    !isLucidModelQuery(query) ||
    q.model.$hooks.has('before:paginate') ||
    q.model.$hooks.has('before:fetch') ||
    !selectKeepsRowCount(q.knexQuery._statements) ||
    !Number.isInteger(page) ||
    page < 1 ||
    !Number.isInteger(perPage) ||
    perPage < 1
  ) {
    return q.paginate(page, perPage);
  }
  return pageThenCount(q, page, perPage);
}

async function pageThenCount(q: LucidModelQuery, page: number, perPage: number): Promise<unknown> {
  const isFetchCall = q.wrapResultsToModelInstances && q.knexQuery._method === 'select';
  const countQuery = q
    .clone()
    .clearOrder()
    .clearLimit()
    .clearOffset()
    .clearSelect()
    .count('* as total')
    .pojo();

  const results = await q.forPage(page, perPage).execQuery();

  let total: unknown;
  if (results.length < perPage && (results.length > 0 || page === 1)) {
    total = (page - 1) * perPage + results.length;
  } else {
    const aggregate = await countQuery.exec();
    total = q.hasGroupBy ? aggregate.length : aggregate[0]?.total;
  }

  const { ModelPaginator } = await import('@adonisjs/lucid/orm');
  const { SimplePaginator } = await import('@adonisjs/lucid/database');
  const paginator = q.wrapResultsToModelInstances
    ? new ModelPaginator(total as number, perPage, page, ...(results as never[]))
    : new SimplePaginator(total as number, perPage, page, ...results);
  paginator.namingStrategy = q.model.namingStrategy as never;

  if (isFetchCall) {
    await q.model.$hooks.runner('after:paginate').run(paginator);
    await q.model.$hooks.runner('after:fetch').run(results);
  }
  return paginator;
}
