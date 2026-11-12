/**
 * A small, safe decoder for a filter query string (`filter[name][contains]=Al&sort=-age&page=2`)
 * into the nested object `ctx.request.qs()` returns: bracket keys become nested objects, numeric
 * indexes and `[]` become arrays. Used by the dev tools, which receive the query as a string.
 */

const BLOCKED = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_PARAMS = 1000;
const MAX_DEPTH = 20;

type Node = Record<string, unknown>;

function decode(part: string): string {
  try {
    return decodeURIComponent(part.replace(/\+/g, ' '));
  } catch {
    return part;
  }
}

/** `filter[name][contains]` → `['filter', 'name', 'contains']`; `a[]` → `['a', '']`. */
function keyPath(key: string): string[] | null {
  const open = key.indexOf('[');
  if (open === -1) return [key];
  const path = [key.slice(0, open)];
  const re = /\[([^\]]*)\]/g;
  re.lastIndex = open;
  let end = open;
  for (let match = re.exec(key); match !== null; match = re.exec(key)) {
    if (match.index !== end) break;
    path.push(match[1] as string);
    end = re.lastIndex;
    if (path.length > MAX_DEPTH) return null;
  }
  if (end !== key.length) path.push(key.slice(end));
  return path;
}

/** Objects whose keys are all array indexes become arrays (in index order). */
function compact(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  const node = value as Node;
  for (const key of Object.keys(node)) node[key] = compact(node[key]);
  const keys = Object.keys(node);
  if (keys.length > 0 && keys.every((k) => /^\d+$/.test(k))) {
    return keys
      .map(Number)
      .sort((a, b) => a - b)
      .map((k) => node[String(k)]);
  }
  return node;
}

/** Decode `query` (with or without a leading `?`) into a nested object. */
export function parseQueryString(query: string): Record<string, unknown> {
  const root: Node = {};
  const text = query.startsWith('?') ? query.slice(1) : query;
  const pairs = text.split('&').filter((p) => p !== '');
  for (const pair of pairs.slice(0, MAX_PARAMS)) {
    const eq = pair.indexOf('=');
    const rawKey = decode(eq === -1 ? pair : pair.slice(0, eq));
    const value = eq === -1 ? '' : decode(pair.slice(eq + 1));
    const path = keyPath(rawKey);
    if (path === null || path[0] === '' || path.some((seg) => BLOCKED.has(seg))) continue;

    let node: Node = root;
    for (let i = 0; i < path.length; i++) {
      let seg = path[i] as string;
      const last = i === path.length - 1;
      if (seg === '') seg = String(Object.keys(node).length);
      if (last) {
        const existing = node[seg];
        if (existing === undefined) node[seg] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else if (typeof existing === 'string') node[seg] = [existing, value];
        break;
      }
      const next = node[seg];
      if (next === undefined || typeof next !== 'object' || next === null || Array.isArray(next)) {
        node[seg] = Object.create(null) as Node;
      }
      node = node[seg] as Node;
    }
  }
  return toPlain(compact(root)) as Record<string, unknown>;
}

/** Null-prototype nodes back to plain objects (so `toEqual` and spreading behave). */
function toPlain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toPlain);
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) out[key] = toPlain(inner);
  return out;
}
