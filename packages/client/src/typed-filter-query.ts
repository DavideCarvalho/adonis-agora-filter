import type { FilterFieldTypes, OperatorsFor, ValueAt, ValueForOp } from './field-types.js';

export type TypedFilterQuery<
  Fields extends string,
  M extends FilterFieldTypes<Fields> = Record<Fields, unknown>,
> = {
  filter?: {
    [K in Fields]?:
      | ValueAt<M, K>
      | { [Op in OperatorsFor<ValueAt<M, K>>]?: ValueForOp<ValueAt<M, K>, Op> };
  };
  include?: string[];
  search?: string;
  sort?: Array<{ field: Fields; direction: 'asc' | 'desc' }>;
  distinct?: Fields[];
  paginate?: { page: number; size: number };
  after?: string;
  before?: string;
  first?: number;
  last?: number;
};
