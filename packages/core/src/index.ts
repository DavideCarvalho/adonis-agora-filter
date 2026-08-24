/** Keep in sync with this package's `version` in package.json. */
export const VERSION = '0.7.0';

export type {
  ColumnFilter,
  FilterOperator,
  FilterOperatorAlias,
  FilterOperatorInput,
} from './operators.js';
export { FILTER_OPERATORS, OPERATOR_ALIASES } from './operators.js';
export {
  InvalidColumnFilterError,
  MAX_FILTER_DEPTH,
  normalizeOperator,
  validateColumnFilter,
  validateColumnFilters,
} from './validate-column-filter.js';
export { isOperatorObject, valueToColumnFilters } from './value-shape.js';
export { escapeLike } from './escape-like.js';
export { parseAggregatePath } from './aggregate_path.js';
export type { AggregateFn, AggregatePath } from './aggregate_path.js';
export { discoverAggregateSources } from './aggregate.js';
export type { LucidModelLike, LucidRelationLike } from './aggregate.js';
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
  defineFilter,
  FilterDefinitionError,
  specToFilterConfig,
} from './filter_spec.js';
export {
  filterableFieldPaths,
  generateFilterClient,
  generateFilterClients,
  sortableFieldPaths,
} from './generate_client.js';
export type {
  FilterClientEntry,
  FilterClientManifest,
  FilterFieldKind,
  FilterFieldTypeInfo,
  GeneratedFilterClient,
  GenerateFilterClientOptions,
} from './generate_client.js';
export type {
  DefineFilterOptions,
  FilterSpec,
  RelationColumns,
  RelationSpec,
  TenantResolver,
  TenantScopeSpec,
} from './filter_spec.js';
export { applyCursorFromRequest, applyFilterFromRequest } from './apply_from_request.js';
export type {
  ApplyCursorFromRequestOptions,
  ApplyFromRequestOptions,
  FilterRequestContext,
} from './apply_from_request.js';
export { registerFilterMacros } from './lucid_macros.js';
export type { MacroableQueryBuilder } from './lucid_macros.js';
export { parseDistinct, parseFilterRequest, parseSort, toColumnFilters } from './parse_request.js';
export { parseSpatieRequest } from './spatie_parser.js';
export type { SpatieInput } from './spatie_parser.js';
export { applyCursor, applyFilter } from './runner.js';
export type { CursorConfig, ResolvedPagination } from './runner.js';
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
  resolveComputedExpression,
  type FullTextSearchOptions,
  type QueryBuilderLike,
  type VectorDistanceMetric,
  type VectorSimilarityOptions,
} from './lucid_adapter.js';
export {
  buildCursorPage,
  buildKeyset,
  decodeCursor,
  encodeCursor,
  extractCursorValues,
  reverseKeyset,
} from './cursor.js';
export type { CursorPage, CursorParams, CursorValues, ResolvedCursor } from './cursor.js';
export {
  remapDistinctAliases,
  remapFilterAliases,
  remapSortAliases,
  resolveFieldAlias,
} from './field_aliases.js';
export type { FieldAliases } from './field_aliases.js';
export { normalizeInput } from './normalizer.js';
export type { NormalizeOptions } from './normalizer.js';
export { resolveInputFromRequest } from './source_resolver.js';
