import {
  type ColumnFilter,
  FILTER_OPERATORS,
  type FilterOperator,
  OPERATOR_ALIASES,
} from './operators.js';

const operatorSet = new Set<string>(FILTER_OPERATORS);

/**
 * Normalizes an operator string to its canonical {@link FilterOperator},
 * resolving SQL-symbol aliases (`=` -> `equals`, `!=` -> `notEquals`, ...).
 * Canonical operators (and unknown strings) pass through unchanged.
 */
export function normalizeOperator(operator: string): FilterOperator {
  return (OPERATOR_ALIASES[operator] ?? operator) as FilterOperator;
}

/**
 * Operators that require no value (unary operators).
 */
const UNARY_OPERATORS = new Set<FilterOperator>([
  'isEmpty',
  'isNotEmpty',
  'isNull',
  'isNotNull',
  'exists',
  'notExists',
]);

/**
 * Operators that require an array value.
 */
const ARRAY_OPERATORS = new Set<FilterOperator>([
  'in',
  'notIn',
  'isAnyOf',
  'between',
  'notBetween',
]);

/**
 * Maximum allowed nesting depth for AND/OR filter composition.
 * Prevents stack overflow from maliciously deep payloads (DoS).
 */
export const MAX_FILTER_DEPTH = 10;

/**
 * A bad client request (disallowed field, malformed filter, uncoercible value).
 * Carries `status = 400` and a stable `code`, so AdonisJS's exception handler
 * renders it as a `400 Bad Request` with no extra mapping.
 */
export class InvalidColumnFilterError extends Error {
  readonly status = 400;
  readonly code = 'E_INVALID_COLUMN_FILTER';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidColumnFilterError';
  }
}

/**
 * Validates a ColumnFilter at runtime:
 * - field must be a non-empty string with no SQL-unsafe characters
 * - operator must be a known FilterOperator
 * - value is required for non-unary operators
 * - 'between' requires a 2-element array
 * - 'in'/'isAnyOf' require arrays
 * - AND/OR arrays are validated recursively
 */
export function validateColumnFilter(filter: ColumnFilter, depth = 0): void {
  if (depth > MAX_FILTER_DEPTH) {
    throw new InvalidColumnFilterError(
      `Filter nesting exceeds maximum depth (${MAX_FILTER_DEPTH}).`,
    );
  }

  if (!filter || typeof filter !== 'object') {
    throw new InvalidColumnFilterError('Column filter must be a non-null object.');
  }

  // Pure group node: `{ AND: [...] }` / `{ OR: [...] }` with no column of its
  // own composes child filters and has no field/operator/value to validate.
  // The client builder emits these (sometimes with an empty `field`), so treat
  // an empty field as absent. Validate only the nested arrays, then stop.
  const isGroupNode =
    (filter.AND !== undefined || filter.OR !== undefined) &&
    (filter.field === undefined || filter.field === '');
  if (isGroupNode) {
    for (const key of ['AND', 'OR'] as const) {
      const group = filter[key];
      if (group !== undefined) {
        if (!Array.isArray(group)) {
          throw new InvalidColumnFilterError(`"${key}" must be an array of ColumnFilter.`);
        }
        for (const sub of group) {
          validateColumnFilter(sub, depth + 1);
        }
      }
    }
    return;
  }

  // Validate field
  if (typeof filter.field !== 'string' || filter.field.length === 0) {
    throw new InvalidColumnFilterError('Column filter "field" must be a non-empty string.');
  }
  // Reject field names that contain SQL-unsafe characters
  if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(filter.field)) {
    throw new InvalidColumnFilterError(
      `Column filter field "${filter.field}" contains invalid characters. Only letters, digits, underscores, and dots are allowed.`,
    );
  }

  // Validate operator, accepting SQL-symbol aliases (`=`, `!=`, `<`, ...).
  const op = normalizeOperator(filter.operator);
  if (!operatorSet.has(op)) {
    throw new InvalidColumnFilterError(
      `Unknown filter operator "${filter.operator}". ` +
        `Valid operators: ${FILTER_OPERATORS.join(', ')}.`,
    );
  }
  // Persist the canonical form so downstream query builders never see aliases.
  filter.operator = op;

  // Reject null for non-unary operators (point to isNull instead)
  if (!UNARY_OPERATORS.has(op) && filter.value === null) {
    throw new InvalidColumnFilterError(
      `Operator "${op}" received null. Use "isNull" for NULL checks.`,
    );
  }

  // Validate value
  if (UNARY_OPERATORS.has(op)) {
    // Unary operators don't need a value — ignore any provided value
  } else if (op === 'between' || op === 'notBetween') {
    if (!Array.isArray(filter.value) || filter.value.length !== 2) {
      throw new InvalidColumnFilterError(
        `Operator "${op}" requires a value that is a 2-element array, got: ${JSON.stringify(filter.value)}.`,
      );
    }
  } else if (ARRAY_OPERATORS.has(op)) {
    if (!Array.isArray(filter.value)) {
      throw new InvalidColumnFilterError(
        `Operator "${op}" requires an array value, got: ${typeof filter.value}.`,
      );
    }
  } else {
    if (filter.value === undefined) {
      throw new InvalidColumnFilterError(`Operator "${op}" requires a value.`);
    }
  }

  // Validate nested AND
  if (filter.AND !== undefined) {
    if (!Array.isArray(filter.AND)) {
      throw new InvalidColumnFilterError('"AND" must be an array of ColumnFilter.');
    }
    for (const sub of filter.AND) {
      validateColumnFilter(sub, depth + 1);
    }
  }

  // Validate nested OR
  if (filter.OR !== undefined) {
    if (!Array.isArray(filter.OR)) {
      throw new InvalidColumnFilterError('"OR" must be an array of ColumnFilter.');
    }
    for (const sub of filter.OR) {
      validateColumnFilter(sub, depth + 1);
    }
  }
}

/**
 * Validates an array of ColumnFilter objects.
 */
export function validateColumnFilters(filters: ColumnFilter[]): void {
  if (!Array.isArray(filters)) {
    throw new InvalidColumnFilterError('Column filters must be an array.');
  }
  for (const filter of filters) {
    validateColumnFilter(filter);
  }
}
