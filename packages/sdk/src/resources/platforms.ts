import {
  PlatformExportResponseSchema,
  PlatformListResponseSchema,
  type PlatformDescriptor,
  type PlatformExportRequestInput,
  type PlatformExportResponse,
} from '@indx-workspace/contracts/platforms';

import { segment, type HttpClient, type RequestOptions } from '../http.js';
import { filenameFromContentDisposition } from './files.js';

/** What to compile a stored version for: the target and its options (`extensions.platforms[platform]`). */
export type PlatformExportTarget = Omit<PlatformExportRequestInput, 'version'>;

/** One export as a tar, with the name the server gave it. */
export interface PlatformArchive {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly contentType: string;
}

/**
 * `/api/platforms` and `/api/agents/:id/platform-exports` — spec §5.16 (issue #968, ADR-0133).
 * The external agent platforms a saved agent version can be compiled for, and that compile.
 *
 * An export is of one **stored** version, so save one first (`agents.versions.create`). It is
 * generated, never executed: the files and the per-field verdict report are what you take to the
 * platform. Secrets are never in them; a credential appears only as a reference by name.
 */
export class PlatformsClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** Every platform target, in catalogue order, with what each can honour. */
  public async list(options: RequestOptions = {}): Promise<readonly PlatformDescriptor[]> {
    const response = await this.#http.json({
      operation: 'platforms.list',
      method: 'GET',
      path: '/api/platforms',
      expect: [200],
      schema: PlatformListResponseSchema,
      signal: options.signal,
    });
    return response.platforms;
  }

  /**
   * Compile version `version` of the agent for `target.platform`: the files (text as `utf8`, bytes
   * as `base64`, plus `PLATFORM_REPORT.md`) and the verdict of every field.
   */
  public async export(
    agentId: string,
    version: number,
    target: PlatformExportTarget,
    options: RequestOptions = {},
  ): Promise<PlatformExportResponse> {
    const body: PlatformExportRequestInput = { version, ...target };
    return this.#http.json({
      operation: 'platforms.export',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/platform-exports`,
      body,
      expect: [200],
      schema: PlatformExportResponseSchema,
      signal: options.signal,
    });
  }

  /** {@link export} as one tar: the same files, ready to unpack. */
  public async exportArchive(
    agentId: string,
    version: number,
    target: PlatformExportTarget,
    options: RequestOptions = {},
  ): Promise<PlatformArchive> {
    const body: PlatformExportRequestInput = { version, ...target };
    const response = await this.#http.send({
      operation: 'platforms.exportArchive',
      method: 'POST',
      path: `/api/agents/${segment(agentId)}/platform-archives`,
      body,
      expect: [200],
      signal: options.signal,
    });
    const disposition = response.headers.get('content-disposition');
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      filename:
        (disposition === null ? null : filenameFromContentDisposition(disposition)) ??
        `${agentId}-${target.platform}-v${version}.tar`,
      contentType: response.headers.get('content-type') ?? 'application/x-tar',
    };
  }
}
