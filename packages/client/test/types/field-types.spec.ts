import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  AllUnaryOps,
  ArrayOps,
  EqualityOps,
  OperatorsFor,
  OrderingOps,
  StringOps,
  TupleOps,
  ValueForOp,
} from '../../src/field-types.js';
import { FilterQueryBuilder } from '../../src/filter-query-builder.js';
import { filterQueryTyped } from '../../src/typed-filter-query-builder.js';
import type { FilterOperator } from '../../src/types.js';
import { FILTER_OPERATORS } from '../../src/types.js';
import {
  ARRAY_OPERATORS,
  ARRAY_OPS,
  RANGE_OPS,
  SCALAR_OPERATORS,
  SCALAR_OPS,
  STRING_OPERATORS,
  STRING_OPS,
  TUPLE_OPERATORS,
  TUPLE_OPS,
  UNARY_OPERATORS,
  UNARY_OPS,
} from '../../src/validate-operator-value.js';

describe('OperatorsFor matrix', () => {
  it('unknown → full operator union (permissive fallback)', () => {
    expectTypeOf<OperatorsFor<unknown>>().toEqualTypeOf<FilterOperator>();
  });
  it('string allows string ops, forbids ordering/tuple', () => {
    expectTypeOf<'contains'>().toMatchTypeOf<OperatorsFor<string>>();
    expectTypeOf<'gt'>().not.toMatchTypeOf<OperatorsFor<string>>();
    expectTypeOf<'between'>().not.toMatchTypeOf<OperatorsFor<string>>();
  });
  it('number allows ordering+tuple, forbids string ops', () => {
    expectTypeOf<'gte'>().toMatchTypeOf<OperatorsFor<number>>();
    expectTypeOf<'between'>().toMatchTypeOf<OperatorsFor<number>>();
    expectTypeOf<'contains'>().not.toMatchTypeOf<OperatorsFor<number>>();
  });
  it('Date behaves like number', () => {
    expectTypeOf<'between'>().toMatchTypeOf<OperatorsFor<Date>>();
    expectTypeOf<'contains'>().not.toMatchTypeOf<OperatorsFor<Date>>();
  });
  it('boolean: equality + unary only', () => {
    expectTypeOf<'equals'>().toMatchTypeOf<OperatorsFor<boolean>>();
    expectTypeOf<'gt'>().not.toMatchTypeOf<OperatorsFor<boolean>>();
    expectTypeOf<'contains'>().not.toMatchTypeOf<OperatorsFor<boolean>>();
  });
  it('nullable strips to base', () => {
    expectTypeOf<'gt'>().toMatchTypeOf<OperatorsFor<number | null>>();
  });
});

describe('ValueForOp', () => {
  it('array op → T[]', () => {
    expectTypeOf<ValueForOp<number, 'in'>>().toEqualTypeOf<number[]>();
  });
  it('tuple op → [T,T]', () => {
    expectTypeOf<ValueForOp<number, 'between'>>().toEqualTypeOf<[number, number]>();
  });
  it('unary → never', () => {
    expectTypeOf<ValueForOp<number, 'isNull'>>().toEqualTypeOf<never>();
  });
  it('string op → string regardless of T', () => {
    expectTypeOf<ValueForOp<string, 'contains'>>().toEqualTypeOf<string>();
  });
  it('equality/ordering op → Base<T>', () => {
    expectTypeOf<ValueForOp<number, 'equals'>>().toEqualTypeOf<number>();
    expectTypeOf<ValueForOp<number, 'gt'>>().toEqualTypeOf<number>();
  });
  // Exhaustiveness guard. The fallthrough arm now resolves to `never` (made explicit),
  // so an operator missing from every group would silently get value type `never`
  // instead of `unknown`. We assert it directly: a non-grouped token hits the
  // fallthrough (`never`), while every NON-unary real operator resolves to a
  // non-never value type. Combined with the per-op tests above (which cover one op
  // from each group), a future operator added to FilterOperator but not to a group
  // would resolve to `never` and break its call sites — surfacing the gap.
  it('non-grouped token hits the never fallthrough', () => {
    expectTypeOf<ValueForOp<number, 'not_a_real_op'>>().toEqualTypeOf<never>();
  });
  it('every non-unary operator resolves to a concrete (non-never) value type', () => {
    type NonUnaryOp = Exclude<FilterOperator, AllUnaryOps>;
    expectTypeOf<ValueForOp<number, NonUnaryOp>>().not.toEqualTypeOf<never>();
  });
});

describe('backward compat — single generic stays permissive', () => {
  it('filterQueryTyped<Union>() accepts all operators', () => {
    const q = filterQueryTyped<'a' | 'b'>();
    // NO @ts-expect-error here — must compile (regression guard):
    q.where('a', 'contains', 'x');
    q.where('a', 'between', [1, 2]);
    q.where('b', 'in', ['x']);
  });
});

describe('where/add call-site type-awareness (map-passing)', () => {
  it('allows valid type-specific operators/values', () => {
    const q = filterQueryTyped<
      'age' | 'name' | 'createdAt' | 'active',
      { age: number; name: string; createdAt: Date; active: boolean }
    >();

    q.where('age', 'gte', 18);
    q.where('name', 'contains', 'al');
    q.where('createdAt', 'between', [new Date(), new Date()]);
    q.where('age', 'in', [1, 2]);
    q.where('age', 'isNull'); // unary 2-arg
    q.where('name', 'al'); // value shorthand (auto-equals)
    q.where('age', [1, 2]); // value shorthand (auto-in)
    q.add('age', 'gte', 18);
  });

  // Type-only: the body is never executed (so the runtime validateOperatorValue
  // throws don't fire); TS still type-checks the @ts-expect-error matrix.
  it('rejects type-mismatched operators/values', () => {
    function _rejects() {
      const q = filterQueryTyped<
        'age' | 'name' | 'createdAt' | 'active',
        { age: number; name: string; createdAt: Date; active: boolean }
      >();

      // @ts-expect-error — contains is string-only
      q.where('age', 'contains', 'foo');
      // @ts-expect-error — in wants Date[], not string
      q.where('createdAt', 'in', 'ontem');
      // @ts-expect-error — between wants [number, number]
      q.where('age', 'between', 5);
      // @ts-expect-error — boolean has no ordering
      q.where('active', 'gt', true);
      // @ts-expect-error — string has no ordering in add()
      q.add('name', 'gt', 'x');
    }
    expect(_rejects).toBeTypeOf('function');
  });

  it('single-generic builder stays fully permissive (backward compat)', () => {
    const u = filterQueryTyped<'a'>();
    u.where('a', 'contains', 'x');
    u.where('a', 'between', [1, 2]);
    u.add('a', 'gt', 1);
  });

  it('filterQueryTyped returns a FilterQueryBuilder at runtime', () => {
    expect(filterQueryTyped<'a'>()).toBeInstanceOf(FilterQueryBuilder);
  });
});

describe('enum narrowing + convenience-method tightening (Phase 4)', () => {
  it('narrows enum values for where()', () => {
    const q = filterQueryTyped<'status', { status: 'A' | 'B' }>();
    q.where('status', 'equals', 'A');
    q.where('status', 'in', ['A', 'B']);
    expect(q.build).toBeTypeOf('function');
  });

  it('rejects out-of-enum values and ordering on enum/string fields', () => {
    function _rejects() {
      const q = filterQueryTyped<'status', { status: 'A' | 'B' }>();
      // @ts-expect-error — 'C' not in enum
      q.where('status', 'equals', 'C');
      // @ts-expect-error — string-only field, no ordering
      q.where('status', 'gt', 'A');
    }
    expect(_rejects).toBeTypeOf('function');
  });

  it('convenience methods are type-aware', () => {
    const q = filterQueryTyped<
      'age' | 'name' | 'active',
      { age: number; name: string; active: boolean }
    >();
    q.contains('name', 'al');
    q.startsWith('name', 'al');
    q.gte('age', 18);
    q.between('age', 1, 99);
    q.equals('name', 'al');
    q.in('age', [1, 2]);
    expect(q.build).toBeTypeOf('function');
  });

  it('rejects type-mismatched convenience calls', () => {
    function _rejects() {
      const q = filterQueryTyped<
        'age' | 'name' | 'active',
        { age: number; name: string; active: boolean }
      >();
      // @ts-expect-error — contains is string-only; age is number
      q.contains('age', 'x');
      // @ts-expect-error — gt is ordering-only; name is string
      q.gt('name', 'x');
      // @ts-expect-error — between is ordering-only; active is boolean
      q.between('active', true, false);
      // @ts-expect-error — startsWith string-only; age is number
      q.startsWith('age', 'x');
    }
    expect(_rejects).toBeTypeOf('function');
  });

  it('single-generic builder keeps full convenience autocomplete', () => {
    const u = filterQueryTyped<'a' | 'b'>();
    u.contains('a', 'x');
    u.gt('b', 1);
    u.between('a', 1, 2);
    u.startsWith('b', 'x');
    expect(u.build).toBeTypeOf('function');
  });

  it('unary convenience methods are type-gated like where()', () => {
    const q = filterQueryTyped<'age' | 'name', { age: number; name: string }>();
    // isEmpty/isNotEmpty are EmptyUnaryOps — only string fields qualify.
    q.isEmpty('name');
    q.isNotEmpty('name');
    // isNull/isNotNull are CommonUnary — valid on every field type, incl. number.
    q.isNull('age');
    q.isNotNull('age');
    q.isNull('name');
    expect(q.build).toBeTypeOf('function');
  });

  it('rejects empty-unary convenience on fields whose type forbids it', () => {
    function _rejects() {
      const q = filterQueryTyped<'age' | 'name', { age: number; name: string }>();
      // @ts-expect-error — isEmpty is string/json-only; age is number
      q.isEmpty('age');
      // @ts-expect-error — isNotEmpty is string/json-only; age is number
      q.isNotEmpty('age');
    }
    expect(_rejects).toBeTypeOf('function');
  });

  it('single-generic builder keeps empty-unary fully permissive (backward compat)', () => {
    const u = filterQueryTyped<'a' | 'b'>();
    // NO @ts-expect-error — OperatorsFor<unknown> is the full union, every field qualifies:
    u.isEmpty('a');
    u.isNotEmpty('b');
    u.isNull('a');
    expect(u.build).toBeTypeOf('function');
  });
});

// ─── DRIFT GUARD: runtime operator tuples ARE the source of truth ───
// The `*_OPS` tuples in validate-operator-value.ts carry narrow literal types,
// so we assert each tuple's element type directly against its field-types.ts
// group. No hand-retyped third copy: if a tuple or a type group changes, the
// matching assert fails. Per-group (not just the union), so moving an operator
// between groups is caught too.
describe('drift guard: runtime *_OPS tuples mirror the field-types groups', () => {
  it('SCALAR_OPS === EqualityOps | OrderingOps', () => {
    expectTypeOf<(typeof SCALAR_OPS)[number]>().toEqualTypeOf<EqualityOps | OrderingOps>();
  });
  it('STRING_OPS === StringOps', () => {
    expectTypeOf<(typeof STRING_OPS)[number]>().toEqualTypeOf<StringOps>();
  });
  it('ARRAY_OPS === ArrayOps', () => {
    expectTypeOf<(typeof ARRAY_OPS)[number]>().toEqualTypeOf<ArrayOps>();
  });
  it('TUPLE_OPS === TupleOps', () => {
    expectTypeOf<(typeof TUPLE_OPS)[number]>().toEqualTypeOf<TupleOps>();
  });
  it('UNARY_OPS === AllUnaryOps', () => {
    expectTypeOf<(typeof UNARY_OPS)[number]>().toEqualTypeOf<AllUnaryOps>();
  });
  it('RANGE_OPS === OrderingOps (add()-eligible)', () => {
    expectTypeOf<(typeof RANGE_OPS)[number]>().toEqualTypeOf<OrderingOps>();
  });

  it('OperatorsFor<unknown> is the full operator union', () => {
    expectTypeOf<OperatorsFor<unknown>>().toEqualTypeOf<FilterOperator>();
  });

  it('runtime sets (built from the tuples) union == FILTER_OPERATORS', () => {
    const union = new Set([
      ...SCALAR_OPERATORS,
      ...STRING_OPERATORS,
      ...ARRAY_OPERATORS,
      ...TUPLE_OPERATORS,
      ...UNARY_OPERATORS,
    ]);
    expect([...union].sort()).toEqual([...FILTER_OPERATORS].sort());
  });
});
