import { redacted } from '@agent-workspace/core/telemetry';
import { inSpan, SpanKind, SpanStatusCode } from '@agent-workspace/core/tracing';

import type { RequestContext } from './types.js';

/** What identifies one model call on its span; never the prompt, a header or a key. */
export type ModelCall = {
  readonly operation: string;
  readonly model: string;
  readonly context: RequestContext;
};

/** The run's credential, for {@link redacted}; an empty one would mask every character. */
function credentialOf(context: RequestContext): readonly string[] {
  return context.credential === '' ? [] : [context.credential];
}

/**
 * One model call as a CLIENT span (ADR-0155): the operation, the run's provider id, the requested
 * model and the upstream status. Never the prompt, the reply, a header or a key. The model name is
 * caller text, so it is redacted and capped like a log field, with the run's credential masked too.
 */
export function inModelSpan<T>(target: ModelCall, call: () => Promise<T>): Promise<T> {
  const { operation, model, context } = target;
  return inSpan(
    `${operation} ${context.providerId}`,
    SpanKind.CLIENT,
    {
      'gen_ai.operation.name': operation,
      'gen_ai.provider.name': context.providerId,
      'gen_ai.request.model': redacted(model, credentialOf(context)),
    },
    async (span) => {
      const result = await call();
      if (result instanceof Response) {
        span.setAttribute('http.response.status_code', result.status);
        if (result.status >= 400) span.setStatus({ code: SpanStatusCode.ERROR });
      }
      return result;
    },
  );
}
