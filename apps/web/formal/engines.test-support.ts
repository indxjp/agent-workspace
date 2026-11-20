import { asString } from '../../../tests/formal/vectors';

/** Narrowing readers for the `engines` vectors; each names the vector field it refused. */
export function asStringArray(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value.map((entry, index) => asString(entry, `${what}[${String(index)}]`));
}

export function asNullableString(value: unknown, what: string): string | null {
  return value === null ? null : asString(value, what);
}

export function asBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${what}: expected a boolean`);
  return value;
}

export function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new Error(`${what}: expected a number`);
  return value;
}

export function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what}: expected an array`);
  return value;
}
