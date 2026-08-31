/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.8.1';

export type { LucidModelLike, LucidRelationLike } from './aggregate.js';
export { discoverAggregateSources } from './aggregate.js';
export type { AggregateFn, AggregatePath } from './aggregate_path.js';
export { parseAggregatePath } from './aggregate_path.js';
export type {
  ApplyCursorFromRequestOptions,
  ApplyFromRequestOptions,
  FilterRequestContext,
} from './apply_from_request.js';
export { applyCursorFromRequest, applyFilterFromRequest } from './apply_from_request.js';
export { BaseModelFilter } from './base_model_filter.js';
export type { CursorPage, CursorParams, CursorValues, ResolvedCursor } from './cursor.js';
export {
  buildCursorPage,
  buildKeyset,
  decodeCursor,
  encodeCursor,
  extractCursorValues,
  reverseKeyset,
} from './cursor.js';
export type { DualDecorator, StandardDecoratorContext } from './decorators.js';
export { filterable, filterFor, searchable, sortable } from './decorators.js';
export { escapeLike } from './escape-like.js';
export type { FieldAliases } from './field_aliases.js';
export {
  remapDistinctAliases,
  remapFilterAliases,
  remapSortAliases,
  resolveFieldAlias,
} from './field_aliases.js';
export type { FilterClass } from './filter_class.js';
export {
  dispatchKeys,
  isFilterClass,
  methodForKey,
  specFromFilterClass,
} from './filter_class.js';
export type {
  DefineFilterOptions,
  FilterSpec,
  RelationColumns,
  RelationSpec,
  TenantResolver,
  TenantScopeSpec,
} from './filter_spec.js';
export {
  defineFilter,
  FilterDefinitionError,
  specToFilterConfig,
} from './filter_spec.js';
export type { FilterableModelStatics } from './filterable_mixin.js';
export { Filterable } from './filterable_mixin.js';
export type {
  FilterClientEntry,
  FilterClientManifest,
  FilterFieldKind,
  FilterFieldTypeInfo,
  GeneratedFilterClient,
  GenerateFilterClientOptions,
} from './generate_client.js';
export {
  filterableFieldPaths,
  generateFilterClient,
  generateFilterClients,
  sortableFieldPaths,
} from './generate_client.js';
export {
  applyColumnFilters,
  applyComputedField,
  applyComputedSort,
  applyDistinct,
  applyFullTextSearch,
  applyKeyset,
  applySearch,
  applySort,
  applyVectorSimilarity,
  type FullTextSearchOptions,
  type QueryBuilderLike,
  resolveComputedExpression,
  type VectorDistanceMetric,
  type VectorSimilarityOptions,
} from './lucid_adapter.js';
export type { MacroableQueryBuilder } from './lucid_macros.js';
export { registerFilterMacros } from './lucid_macros.js';
export type { NormalizeOptions } from './normalizer.js';
export { normalizeInput } from './normalizer.js';
export type {
  ColumnFilter,
  FilterOperator,
  FilterOperatorAlias,
  FilterOperatorInput,
} from './operators.js';
export { FILTER_OPERATORS, OPERATOR_ALIASES } from './operators.js';
export { parseDistinct, parseFilterRequest, parseSort, toColumnFilters } from './parse_request.js';
export type { CursorConfig, ResolvedPagination } from './runner.js';
export { applyCursor, applyFilter } from './runner.js';
export { resolveInputFromRequest } from './source_resolver.js';
export type { SpatieInput } from './spatie_parser.js';
export { parseSpatieRequest } from './spatie_parser.js';
export type {
  AllowList,
  ComputedContext,
  ComputedFields,
  ComputedSource,
  FilterConfig,
  FilterInput,
  FullTextSearchConfig,
  InputNormalizer,
  InputSource,
  SortItem,
  VectorSimilarityConfig,
} from './types.js';
export {
  InvalidColumnFilterError,
  MAX_FILTER_DEPTH,
  normalizeOperator,
  validateColumnFilter,
  validateColumnFilters,
} from './validate-column-filter.js';
export { isOperatorObject, valueToColumnFilters } from './value-shape.js';
