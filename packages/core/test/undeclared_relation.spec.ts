import { afterEach, describe, expect, it, vi } from 'vitest';
import { explainFilterQuery } from '../src/dev_tools/explain.js';
import { defineFilter, specToFilterConfig, undeclaredRelationReason } from '../src/filter_spec.js';
import { applyFilter } from '../src/runner.js';
import { makeMockQueryBuilder } from './mock_query_builder.js';

/**
 * `filter[medication.nome]` on a spec without `relations.medication`: dropped, like an unknown
 * root column (unless `throwOnInvalid`), but no longer silently. Explain says why, and a running
 * app gets one dev warning per spec and path.
 */

const spec = () =>
  defineFilter({
    filterable: ['name'],
    sortable: ['name'],
    relations: {
      patient: { filterable: ['name'], relations: { clinic: { filterable: ['city'] } } },
    },
  });

const warnings = () => {
  const emit = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
  const undeclared = () =>
    emit.mock.calls.filter(
      (call) =>
        (call[1] as { code?: string } | undefined)?.code === 'AGORA_FILTER_UNDECLARED_RELATION',
    );
  return { emit, undeclared };
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('undeclaredRelationReason', () => {
  it('names the undeclared relation and the option to declare', () => {
    expect(undeclaredRelationReason(spec(), 'medication.nome')).toBe(
      "relation `medication` is not declared in this spec. To allow it, declare `relations.medication` with `filterable: ['nome']`",
    );
    expect(undeclaredRelationReason(spec(), 'patient.billing.total')).toContain(
      '`relations.patient.relations.billing`',
    );
  });

  it('is silent for root columns, declared relations and blocked segments', () => {
    expect(undeclaredRelationReason(spec(), 'secret')).toBeUndefined();
    expect(undeclaredRelationReason(spec(), 'patient.name')).toBeUndefined();
    expect(undeclaredRelationReason(spec(), '__proto__.x')).toBeUndefined();
  });
});

describe('explain on an undeclared relation', () => {
  it('reports the filter and the sort as dropped, saying which relation is missing', () => {
    const out = explainFilterQuery(
      spec(),
      'filter[medication.nome][equals]=x&sort=-medication.nome',
    );
    expect(out.rejected).toBe(false);
    expect(out.issues).toEqual([
      expect.objectContaining({
        part: 'filter',
        subject: 'medication.nome',
        effect: 'dropped',
        message: expect.stringMatching(
          /^dropped: relation `medication` is not declared in this spec/,
        ),
      }),
      expect.objectContaining({ part: 'sort', subject: 'medication.nome', effect: 'dropped' }),
    ]);
  });

  it('adds the reason to a refusal under throwOnInvalid', () => {
    const strict = defineFilter({ filterable: ['name'], throwOnInvalid: true });
    const out = explainFilterQuery(strict, 'filter[medication.nome]=x');
    expect(out.rejected).toBe(true);
    expect(out.issues[0]?.message).toContain('relation `medication` is not declared');
  });

  it('does not emit the request warning itself', () => {
    const { undeclared } = warnings();
    explainFilterQuery(spec(), 'filter[medication.nome]=x');
    expect(undeclared()).toEqual([]);
  });
});

describe('requests through an undeclared relation', () => {
  it('drops the filter as before, and warns once per spec and path', () => {
    const { undeclared } = warnings();
    const s = spec();
    const config = specToFilterConfig(s);
    for (let i = 0; i < 3; i++) {
      const qb = makeMockQueryBuilder();
      applyFilter(
        qb as never,
        { filters: [{ field: 'medication.nome', operator: 'equals', value: 'x' }] },
        config,
      );
      expect(JSON.stringify(qb.calls)).not.toContain('medication');
    }
    expect(undeclared()).toHaveLength(1);
    expect(String(undeclared()[0]?.[0])).toContain(
      'filter on "medication.nome" was dropped: relation `medication` is not declared',
    );

    // A sort through it is a separate warning; another path is too.
    applyFilter(
      makeMockQueryBuilder() as never,
      { sort: [{ field: 'medication.nome', direction: 'asc' }] },
      config,
    );
    applyFilter(
      makeMockQueryBuilder() as never,
      { filters: [{ field: 'dose.amount', operator: 'equals', value: 1 }] },
      config,
    );
    expect(undeclared()).toHaveLength(3);
    // Another spec warns on its own.
    applyFilter(
      makeMockQueryBuilder() as never,
      { filters: [{ field: 'medication.nome', operator: 'equals', value: 'x' }] },
      specToFilterConfig(spec()),
    );
    expect(undeclared()).toHaveLength(4);
  });

  it('does not warn for unknown root columns or in production', () => {
    const { undeclared } = warnings();
    const config = specToFilterConfig(spec());
    applyFilter(
      makeMockQueryBuilder() as never,
      { filters: [{ field: 'secret', operator: 'equals', value: 1 }] },
      config,
    );
    vi.stubEnv('NODE_ENV', 'production');
    applyFilter(
      makeMockQueryBuilder() as never,
      { filters: [{ field: 'medication.nome', operator: 'equals', value: 'x' }] },
      config,
    );
    expect(undeclared()).toEqual([]);
  });

  it('still refuses under throwOnInvalid', () => {
    warnings();
    const config = specToFilterConfig(defineFilter({ filterable: ['name'], throwOnInvalid: true }));
    expect(() =>
      applyFilter(
        makeMockQueryBuilder() as never,
        { filters: [{ field: 'medication.nome', operator: 'equals', value: 'x' }] },
        config,
      ),
    ).toThrow(/not filterable/);
  });
});
