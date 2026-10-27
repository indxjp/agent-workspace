import {
  AuditEventListResponseSchema,
  RunTelemetryListResponseSchema,
  type AuditEvent,
  type AuditEventListResponse,
  type AuditListQuery,
  type RunTelemetry,
} from '@indx-workspace/contracts/observability';

import type { HttpClient, RequestOptions } from '../http.js';
import { walkPages } from '../pagination.js';

/**
 * `GET /api/metrics` — spec §5.14. The web process's own bounded projection of recently finished
 * runs, scoped to the caller's workspace by the server; an operator's glance, not the run store.
 */
export class MetricsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  public async recentRuns(options: RequestOptions = {}): Promise<readonly RunTelemetry[]> {
    const response = await this.#http.json({
      operation: 'observability.metrics.recentRuns',
      method: 'GET',
      path: '/api/metrics',
      expect: [200],
      schema: RunTelemetryListResponseSchema,
      signal: options.signal,
    });
    return response.runs;
  }
}

/**
 * `GET /api/audit-events` — spec §5.14. Owner-only. Newest rows first, cursor-paged: `limit` is
 * 1–500 (the server's default is 100), and `nextCursor` goes back as `cursor` for the next page.
 */
export class AuditClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** One page of the audit trail, and the cursor of the next (`null` on the last). */
  public list(
    query: AuditListQuery = {},
    options: RequestOptions = {},
  ): Promise<AuditEventListResponse> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.cursor !== undefined) params.set('cursor', query.cursor);
    if (query.action !== undefined) params.set('action', query.action);
    return this.#http.json({
      operation: 'observability.audit.list',
      method: 'GET',
      path: '/api/audit-events',
      query: params,
      expect: [200],
      schema: AuditEventListResponseSchema,
      signal: options.signal,
    });
  }

  /** Every audit event, newest first, one page request at a time. */
  public listAll(
    query: AuditListQuery = {},
    options: RequestOptions = {},
  ): AsyncGenerator<AuditEvent, void, undefined> {
    return walkPages('observability.audit.list', query.cursor, async (cursor) => {
      const page = await this.list(
        { ...query, ...(cursor === undefined ? {} : { cursor }) },
        options,
      );
      return { items: page.events, nextCursor: page.nextCursor };
    });
  }
}

/** Metrics and the audit trail — spec §5.14 `aw.observability`. */
export class ObservabilityClient {
  public readonly metrics: MetricsClient;
  public readonly audit: AuditClient;

  public constructor(http: HttpClient) {
    this.metrics = new MetricsClient(http);
    this.audit = new AuditClient(http);
  }
}
