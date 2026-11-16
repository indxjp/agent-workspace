/**
 * What a run makes new every time: the ids the double hands out and the instants it reads from the
 * clock. A recording keeps neither, so a fresh recording equals the committed one.
 */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/gu;

/** `value` with each distinct id replaced by a stable one, in order of appearance, and instants fixed. */
export function normalize<T>(value: T): T {
  const ids = new Map<string, string>();
  const text = JSON.stringify(value)
    .replace(INSTANT, '2026-01-01T00:00:00.000Z')
    .replace(UUID, (id) => {
      const known = ids.get(id.toLowerCase());
      if (known !== undefined) return known;
      const next = `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, '0')}`;
      ids.set(id.toLowerCase(), next);
      return next;
    });
  return JSON.parse(text) as T;
}
