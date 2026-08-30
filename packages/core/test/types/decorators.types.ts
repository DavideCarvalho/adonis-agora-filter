import { compose } from '@adonisjs/core/helpers';
import { BaseModel, column } from '@adonisjs/lucid/orm';
import type { ModelQueryBuilderContract } from '@adonisjs/lucid/types/model';
import { BaseModelFilter } from '../../src/base_model_filter.js';
import { filterFor, filterable, searchable, sortable } from '../../src/decorators.js';
import { Filterable } from '../../src/filterable_mixin.js';

/**
 * Compile-time guard: the decorators must be *applicable* in the only position that matters —
 * a real Lucid model's `declare` columns and a filter class's methods, under the legacy
 * (`experimentalDecorators`) emit every AdonisJS app compiles with, stacked under `@column()`.
 *
 * The runtime specs prove what the decorators record; only this proves an app can write them at
 * all. Failing to COMPILE is the failure signal. This file is never executed.
 *
 * The `override` modifiers are this repo's own `noImplicitOverride: true` talking — AdonisJS's
 * shipped `tsconfig` does not enable it, so an app writes `static filterable = […]` plainly. They
 * are kept here to prove the stricter setting is *also* satisfiable.
 */
class User extends compose(BaseModel, Filterable) {
  @column({ isPrimary: true })
  declare id: number;

  @column()
  @filterable()
  @sortable()
  declare name: string;

  @column()
  @filterable('number')
  @sortable()
  declare age: number;

  @column()
  @searchable()
  declare email: string;

  @column({ serializeAs: null })
  declare passwordHash: string;

  static override $filter = () => UserFilter;
}

class UserFilter extends BaseModelFilter {
  static override model = User;
  static override searchable = ['email'];

  /** Narrowed to the real builder, the way an app writes it. */
  declare $query: ModelQueryBuilderContract<typeof User>;

  @filterFor('team.name')
  byTeamName(value: unknown) {
    this.$query.whereILike('teams.name', `%${String(value)}%`);
  }

  @filterFor('q', 'query')
  freeText(value: unknown) {
    this.$query.whereILike('bio', `%${String(value)}%`);
  }
}

export type { User, UserFilter };
