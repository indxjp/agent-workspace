// Types for the gijiroku-format skill's date script, which is plain JavaScript so it runs with Node
// alone inside a run's sandbox. The tests import it through these declarations.
export function parseIsoDate(text: string): Date | null;
export function formatDate(date: Date): string;
export function addBusinessDays(base: Date, count: number, holidays?: readonly string[]): Date;
export function resolveDate(
  expression: string,
  base: string,
  options?: { readonly holidays?: readonly string[] },
): string | null;
export function weekdayOf(isoDate: string): string;
