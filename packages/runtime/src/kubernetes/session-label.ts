/** A label value is at most 63 characters of `[A-Za-z0-9_.-]`, beginning and ending alphanumeric. */
export function sessionLabelValue(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9_.-]/gu, '-').slice(0, 63);
  return cleaned.replace(/^[^A-Za-z0-9]+/u, '').replace(/[^A-Za-z0-9]+$/u, '') || 'session';
}
