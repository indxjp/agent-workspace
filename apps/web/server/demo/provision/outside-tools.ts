/**
 * Which of a demo template agent's connectors would send or write outside, decided from what the
 * connector says it can do, never from its name. The rule is closed: only a connector shown to
 * read can be left out of a visitor's copy as harmless, and anything not shown to read is a tool
 * that could send, so it is replaced by the stand-in (`fake-send-server.ts`).
 *
 * - A `postgres` tool connector offers only structured reads (`readOnly: true` by its schema).
 * - An `openapi` tool connector reads when every operation it exposes is `GET` or `HEAD`; its
 *   other operations are the ones that write.
 * - An MCP connector's tools are not known from outside, so it is always a stand-in. The one the
 *   deployment's seed declared (`template-connector.ts`) is the exception: it names its read and
 *   write tools, and the plan carries them.
 *
 * A connector row, its secret and its address belong to the template's workspace, so no connector
 * is copied as it is: a reader is not carried into the copy (the sample data is the files), and a
 * writer becomes a stand-in with no address and no secret.
 */
import type { DemoRecordedWrite } from '@indx-workspace/contracts/demo-operator';

import type { AnyConnectorResource } from '../../integrations';
import { declaredTools } from './template-connector';

/**
 * What the visitor's copy gets in place of one template connector. A stand-in answers
 * `DEMO_SEND_RESULT` on its `tools` (the ones that could send or write) and, for each tool in
 * `reads`, from the entry's sample records when the seed has records for it (`records-server.ts`).
 * A write in `recorded` keeps what a person approves, and its read answers with it (ADR-0169).
 */
export type DemoConnectorPlan =
  | { readonly kind: 'omit'; readonly name: string }
  | {
      readonly kind: 'stand-in';
      readonly name: string;
      readonly tools: readonly string[];
      readonly reads: readonly string[];
      readonly recorded: readonly DemoRecordedWrite[];
    };

/** The methods that only read; every other method writes. */
const READING_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

export function planDemoConnector(connector: AnyConnectorResource): DemoConnectorPlan {
  const { name } = connector;
  if (connector.kind === 'postgres') return { kind: 'omit', name };
  if (connector.kind === 'openapi') {
    const writers = (connector.openapi?.operations ?? [])
      .filter((operation) => !READING_METHODS.has(operation.method))
      .map((operation) => operation.name);
    // A connector with no operation listed is not shown to read: it is a stand-in.
    const reads = (connector.openapi?.operations.length ?? 0) > 0 && writers.length === 0;
    return reads
      ? { kind: 'omit', name }
      : { kind: 'stand-in', name, tools: writers, reads: [], recorded: [] };
  }
  // A connector the deployment's seed declared says which of its tools read and which write.
  const declared = declaredTools(connector);
  if (declared !== null) {
    const { writes, reads, recorded } = declared;
    return { kind: 'stand-in', name, tools: writes, reads, recorded };
  }
  return { kind: 'stand-in', name, tools: [], reads: [], recorded: [] };
}
