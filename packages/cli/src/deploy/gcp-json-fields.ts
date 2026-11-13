type Json = Readonly<Record<string, unknown>>;

export function field(value: unknown, key: string): unknown {
  return isJson(value) ? value[key] : undefined;
}

export function isJson(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
