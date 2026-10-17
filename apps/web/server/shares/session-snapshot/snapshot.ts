export interface SnapshotOptions {
  readonly technicalDetails?: boolean;
  readonly outputFiles?: boolean;
}
const SENSITIVE_KEY =
  /(secret|token|credential|password|authorization|api[_-]?key|environment|env)/i;
const INTERNAL_URL =
  /https?:\/\/(?:localhost|127\.0\.0\.1|[^\s"']+\.(?:internal|local)|gateway(?::\d+)?)(?:\/[^\s"']*)?/gi;
export function createSessionSnapshot(
  entries: readonly unknown[],
  secretValues: readonly string[],
  options: SnapshotOptions = {},
): readonly unknown[] {
  const redact = (value: unknown, key = ''): unknown => {
    if (SENSITIVE_KEY.test(key)) return '[REDACTED]';
    if (typeof value === 'string') {
      let result = value.replace(INTERNAL_URL, '[REDACTED_URL]');
      for (const secret of secretValues.filter(Boolean))
        result = result.split(secret).join('[REDACTED]');
      return result;
    }
    if (Array.isArray(value)) return value.map((item) => redact(item, key));
    if (value && typeof value === 'object') {
      const input = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(input)) {
        if (
          !options.technicalDetails &&
          ['rawSdkEvent', 'raw_event', 'tokenUsage'].includes(childKey)
        )
          continue;
        if (
          !options.outputFiles &&
          ['fileContent', 'contentBytes', 'attachments'].includes(childKey)
        )
          continue;
        if (!options.technicalDetails && ['toolArguments', 'arguments', 'input'].includes(childKey))
          continue;
        output[childKey] = redact(child, childKey);
      }
      return output;
    }
    return value;
  };
  return entries.map((entry) => redact(entry));
}
