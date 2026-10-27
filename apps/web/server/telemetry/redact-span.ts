import type { Attributes, Span } from '@opentelemetry/api';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace';

/** ADR-0144 D2: the trigger secret is the path segment after `/fire/`; it must never reach a trace. */
const FIRE_SECRET = /(\/fire\/)(?!\[)[^/?#\s]+/gu; // a `[param]` route template is not a secret

export function redactTriggerSecret(value: string): string {
  return value.replace(FIRE_SECRET, '$1[redacted]');
}

/** Rewrites the span name and every URL-carrying attribute that exposes `/fire/<secret>`. */
export function redactSpanStart(
  span: Span,
  name: string,
  attributes: Readonly<Record<string, unknown>>,
): void {
  const redactedName = redactTriggerSecret(name);
  if (redactedName !== name) span.updateName(redactedName);
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value !== 'string') continue;
    const redacted = redactTriggerSecret(value);
    if (redacted !== value) span.setAttribute(key, redacted);
  }
}

function redactAttributes(attributes: Attributes): Attributes {
  return Object.fromEntries(
    Object.entries(attributes).map(([key, value]) => [
      key,
      typeof value === 'string' ? redactTriggerSecret(value) : value,
    ]),
  );
}

/** Export-time safety net: attributes set after span start are redacted before they leave the process. */
export function redactingExporter(inner: SpanExporter): SpanExporter {
  const redact = (span: ReadableSpan): ReadableSpan => {
    const overrides: Record<string | symbol, unknown> = {
      name: redactTriggerSecret(span.name),
      attributes: redactAttributes(span.attributes),
      events: span.events.map((event) => ({
        ...event,
        ...(event.attributes ? { attributes: redactAttributes(event.attributes) } : {}),
      })),
    };
    // A proxy, not a spread: ReadableSpan is a class instance whose getters need the real `this`.
    return new Proxy(span, {
      get(target, prop) {
        if (prop in overrides) return overrides[prop];
        const value: unknown = Reflect.get(target, prop, target);
        return typeof value === 'function' ? (value.bind(target) as unknown) : value;
      },
    });
  };
  return {
    export: (spans, done) => inner.export(spans.map(redact), done),
    shutdown: () => inner.shutdown(),
    ...(inner.forceFlush ? { forceFlush: () => inner.forceFlush?.() ?? Promise.resolve() } : {}),
  };
}
