import { describe, expect, it } from 'vitest';
import { applyFilterFromRequest } from '../src/apply_from_request.js';
import { BaseModelFilter } from '../src/base_model_filter.js';
import { filterable, filterFor, searchable, sortable } from '../src/decorators.js';
import { dispatchKeys, methodForKey, specFromFilterClass } from '../src/filter_class.js';
import { FilterDefinitionError } from '../src/filter_spec.js';
import { MockQueryBuilder } from './mock_query_builder.js';

function ctxWith(qs: Record<string, unknown>) {
  return { request: { qs: () => qs } };
}

/** The symbol TypeScript's standard-decorator emit stamps the metadata object on. */
const METADATA: symbol =
  (Symbol as { metadata?: symbol }).metadata ?? Symbol.for('Symbol.metadata');

/**
 * Apply a decorator the way TC39/TypeScript 5 standard decorators do — a value plus a context
 * object — rather than the legacy `(prototype, key)` pair the repo's tsconfig emits. This is the
 * only way to exercise the standard branch from a suite compiled with `experimentalDecorators`.
 */
function applyStandardMethodDecorator(
  cls: { prototype: Record<string, unknown> },
  name: string,
  decorator: unknown,
): void {
  const parentMetadata = (Object.getPrototypeOf(cls) as Record<symbol, object> | null)?.[METADATA];
  const metadata = Object.create(parentMetadata ?? null);
  const context = {
    kind: 'method' as const,
    name,
    static: false,
    private: false,
    metadata,
    addInitializer() {},
  };
  (decorator as (value: unknown, context: unknown) => void)(cls.prototype[name], context);
  Object.defineProperty(cls, METADATA, {
    value: metadata,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

/** The same, for a field: what a standard field decorator is handed. */
function applyStandardFieldDecorator(cls: object, name: string, decorator: unknown): void {
  const parentMetadata = (Object.getPrototypeOf(cls) as Record<symbol, object> | null)?.[METADATA];
  const metadata = Object.create(parentMetadata ?? null);
  const context = {
    kind: 'field' as const,
    name,
    static: false,
    private: false,
    metadata,
    addInitializer() {},
  };
  (decorator as (value: unknown, context: unknown) => void)(undefined, context);
  Object.defineProperty(cls, METADATA, {
    value: metadata,
    configurable: true,
    writable: true,
    enumerable: true,
  });
}

describe('@filterFor — binding a request key to a method', () => {
  class UserFilter extends BaseModelFilter {
    static filterable = ['status'];

    @filterFor('team.name')
    byTeamName(value: unknown) {
      this.$query.whereILike('teams.name', `%${String(value)}%`);
    }

    @filterFor('q', 'query')
    freeText(value: unknown) {
      this.$query.whereILike('bio', `%${String(value)}%`);
    }

    minAge(value: unknown) {
      this.$query.where('age', '>=', value);
    }
  }

  it('dispatches a key that could never be a method name', async () => {
    const qb = new MockQueryBuilder();

    await applyFilterFromRequest(qb, UserFilter, ctxWith({ filter: { 'team.name': 'corvos' } }));

    expect(qb.flatten()).toContainEqual({
      method: 'whereILike',
      args: ['teams.name', '%corvos%'],
    });
  });

  it('binds several keys to one method', () => {
    expect(methodForKey(UserFilter, 'q')).toBe('freeText');
    expect(methodForKey(UserFilter, 'query')).toBe('freeText');
  });

  it('stops dispatching a decorated method by its own name', () => {
    expect(methodForKey(UserFilter, 'byTeamName')).toBeUndefined();
    expect(methodForKey(UserFilter, 'freeText')).toBeUndefined();
    // an undecorated method keeps the name convention
    expect(methodForKey(UserFilter, 'min_age')).toBe('minAge');
  });

  it('leaves decorated methods out of the name-dispatched key set', () => {
    expect([...dispatchKeys(UserFilter)]).toEqual(['minAge']);
  });

  it('an explicit key wins over the name convention', () => {
    class Precedence extends BaseModelFilter {
      static filterable = [];

      @filterFor('full_name')
      explicit(value: unknown) {
        this.$query.where('explicit', value);
      }

      fullName(value: unknown) {
        this.$query.where('convention', value);
      }
    }

    expect(methodForKey(Precedence, 'full_name')).toBe('explicit');
  });

  it('refuses a key the wire format already owns', () => {
    expect(() => {
      class Bad extends BaseModelFilter {
        @filterFor('sort')
        nope() {}
      }
      return Bad;
    }).toThrow(FilterDefinitionError);
  });

  it('refuses a binding with no key at all', () => {
    expect(() => {
      class Bad extends BaseModelFilter {
        @filterFor()
        nope() {}
      }
      return Bad;
    }).toThrow(FilterDefinitionError);
  });

  it('inherits a base filter’s bindings', async () => {
    class BaseScoped extends BaseModelFilter {
      static filterable = [];

      @filterFor('team.name')
      byTeamName(value: unknown) {
        this.$query.whereILike('teams.name', `%${String(value)}%`);
      }
    }
    class Concrete extends BaseScoped {}

    expect(methodForKey(Concrete, 'team.name')).toBe('byTeamName');

    const qb = new MockQueryBuilder();
    await applyFilterFromRequest(qb, Concrete, ctxWith({ filter: { 'team.name': 'corvos' } }));
    expect(qb.flatten()).toContainEqual({ method: 'whereILike', args: ['teams.name', '%corvos%'] });
  });

  it('keeps a subclass’s standard-flavor bindings off its base', () => {
    class BaseFilter extends BaseModelFilter {
      static filterable = [];
      byBase(value: unknown) {
        this.$query.where('base', value);
      }
    }
    applyStandardMethodDecorator(BaseFilter, 'byBase', filterFor('base.key'));

    class SubFilter extends BaseFilter {
      bySub(value: unknown) {
        this.$query.where('sub', value);
      }
    }
    applyStandardMethodDecorator(SubFilter, 'bySub', filterFor('sub.key'));

    expect(methodForKey(SubFilter, 'base.key')).toBe('byBase');
    expect(methodForKey(SubFilter, 'sub.key')).toBe('bySub');
    // the base must not have grown a binding for a method it does not have
    expect(methodForKey(BaseFilter, 'sub.key')).toBeUndefined();
  });

  it('registers through a standard (TC39) decorator context too', async () => {
    class StandardFilter extends BaseModelFilter {
      static filterable = [];
      byTag(value: unknown) {
        this.$query.where('tag', value);
      }
    }
    applyStandardMethodDecorator(StandardFilter, 'byTag', filterFor('tag.slug'));

    expect(methodForKey(StandardFilter, 'tag.slug')).toBe('byTag');
    expect(methodForKey(StandardFilter, 'byTag')).toBeUndefined();

    const qb = new MockQueryBuilder();
    await applyFilterFromRequest(qb, StandardFilter, ctxWith({ filter: { 'tag.slug': 'raro' } }));
    expect(qb.flatten()).toContainEqual({ method: 'where', args: ['tag', 'raro'] });
  });
});

describe('@filterable / @sortable / @searchable — the model declares its own surface', () => {
  class Bird {
    static table = 'birds';
    static $getRelation() {
      return undefined;
    }

    @filterable()
    declare name: string;

    @sortable()
    @filterable('number')
    declare wingspan: number;

    @searchable()
    @filterable()
    declare family: string;

    declare passwordHash: string;
  }

  class BirdFilter extends BaseModelFilter {
    static model = Bird;
  }

  it('turns the decorated columns into the filter’s allow-list', () => {
    const spec = specFromFilterClass(BirdFilter);
    expect([...spec.filterable].sort()).toEqual(['family', 'name', 'wingspan']);
  });

  it('leaves an undecorated column unreachable', () => {
    expect(specFromFilterClass(BirdFilter).isFilterable('passwordHash')).toBe(false);
  });

  it('carries the declared kind into fieldTypes, and declares nothing for the rest', () => {
    const spec = specFromFilterClass(BirdFilter);
    expect(spec.fieldTypes?.wingspan).toEqual({ kind: 'number' });
    expect(spec.fieldTypes?.name).toBeUndefined();
  });

  it('coerces with that kind, like the map form does', async () => {
    const qb = new MockQueryBuilder();
    await applyFilterFromRequest(
      qb,
      BirdFilter,
      ctxWith({ filter: { wingspan: { equals: '3' } } }),
    );
    expect(qb.find('where')?.args).toEqual(['wingspan', 3]);
  });

  it('reads @sortable and @searchable off the same columns', () => {
    const spec = specFromFilterClass(BirdFilter);
    expect(spec.sortable).toEqual(['wingspan']);
    expect(spec.searchable).toEqual(['family']);
  });

  it('lets a filter narrow the model’s surface with a static', () => {
    class PublicBirdFilter extends BaseModelFilter {
      static model = Bird;
      static filterable = ['family'];
    }

    const spec = specFromFilterClass(PublicBirdFilter);
    expect(spec.isFilterable('family')).toBe(true);
    expect(spec.isFilterable('name')).toBe(false);
  });

  it('inherits the columns a base model declared', () => {
    class Owl extends Bird {
      static table = 'owls';
    }
    class OwlFilter extends BaseModelFilter {
      static model = Owl;
    }

    expect(specFromFilterClass(OwlFilter).isFilterable('wingspan')).toBe(true);
  });

  it('registers through a standard (TC39) field context too', () => {
    class Nest {
      static table = 'nests';
      static $getRelation() {
        return undefined;
      }
      declare twigs: number;
    }
    applyStandardFieldDecorator(Nest, 'twigs', filterable('number'));

    class NestFilter extends BaseModelFilter {
      static model = Nest;
    }

    const spec = specFromFilterClass(NestFilter);
    expect(spec.isFilterable('twigs')).toBe(true);
    expect(spec.fieldTypes?.twigs).toEqual({ kind: 'number' });
  });
});
