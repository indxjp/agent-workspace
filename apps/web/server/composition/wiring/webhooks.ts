import type { SecretsService } from '@agent-workspace/core/secrets';
import type { Logger } from '@agent-workspace/core/telemetry';

import { startWebhookDeliveryWorker, WEBHOOK_DELIVERY_INTERVAL_MS } from '../../webhooks/delivery';
import type { Webhooks } from '../../webhooks/runtime';
import {
  createRepositoryWebhookDeliverySources,
  createRepositoryWebhooksRuntime,
} from '../../webhooks/store';

/**
 * Build the webhook routes' runtime and start the delivery worker (N-3, ADR-SDK-18-N3-250). `root`
 * is typed by the store adapter, the one webhooks file that may name `core/db` (F-15).
 *
 * With no secrets service a signing secret can be neither stored nor read, so the routes are
 * `unavailable` (503) and no worker starts: no webhook can exist, so no delivery is owed. The worker
 * does not need a run runtime; it only ever finds rows a stopped run wrote.
 */
export function wireWebhooks(
  root: Parameters<typeof createRepositoryWebhooksRuntime>[0],
  secretsService: SecretsService | null,
  options: Readonly<{
    log: Pick<Logger, 'error' | 'info'>;
    stopOnClose: (stop: () => void) => void;
  }>,
): Webhooks {
  const { log } = options;
  if (secretsService === null) {
    log.info('[compose] webhooks unavailable: no secrets service to keep their signing secrets');
    return { kind: 'unavailable' };
  }
  options.stopOnClose(
    startWebhookDeliveryWorker({
      ...createRepositoryWebhookDeliverySources(root, secretsService),
      intervalMs: WEBHOOK_DELIVERY_INTERVAL_MS,
      onError: (error) => log.error('[compose] webhook delivery pass failed', { error }),
    }),
  );
  log.info('[compose] webhooks installed; deliveries every 5 seconds');
  return { kind: 'serving', runtime: createRepositoryWebhooksRuntime(root, secretsService) };
}
