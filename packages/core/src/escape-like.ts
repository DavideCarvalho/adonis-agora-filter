/**
 * Escapes special characters in a LIKE pattern value.
 *
 * @param value - The raw string to escape.
 * @param dialect - The SQL dialect to target.
 *   - `'standard'` (default): escapes `%`, `_`, and `\` with a backslash.
 *   - `'mssql'`: escapes `%`, `_`, and `[` using bracket notation (`[$&]`).
 */
export function escapeLike(value: string, dialect: 'standard' | 'mssql' = 'standard'): string {
  if (dialect === 'mssql') {
    return value.replace(/[%_[]/g, '[$&]');
  }
  return value.replace(/[%_\\]/g, '\\$&');
}
