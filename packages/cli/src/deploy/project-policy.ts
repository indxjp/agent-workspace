function byCodeUnit(left: string, right: string): number {
  if (left === right) return 0;
  return left > right ? 1 : -1;
}

/**
 * JSON with object keys sorted at every depth and no whitespace, so equal policies are equal
 * strings. Restated from `aw dev`'s writer: the published CLI must not import `embedded`.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries: [string, unknown][] = Object.entries(value);
    return `{${entries
      .filter(([, member]) => member !== undefined)
      .sort(([left], [right]) => byCodeUnit(left, right))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
