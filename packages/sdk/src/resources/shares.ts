import { z } from 'zod';

import {
  ShareListResponseSchema,
  ShareResourceSchema,
  type PublishShareCommand,
  type ShareListItem,
  type ShareResource,
} from '@indx-workspace/contracts/shares';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

const NoContentSchema = z.null();

/**
 * Exactly the fields the route accepts, and no absent ones: the route is strict, and a wider
 * object a caller happens to hold (transcript text, a snapshot) must never become part of the body:
 * a transcript travels only as the run ids it chose (ADR-0158).
 */
function publishBody(command: PublishShareCommand): PublishShareCommand {
  return {
    subjectType: command.subjectType,
    subjectId: command.subjectId,
    subjectLabel: command.subjectLabel,
    visibility: command.visibility,
    ...(command.mode === undefined ? {} : { mode: command.mode }),
    ...(command.include === undefined ? {} : { include: command.include }),
    ...(command.transcript === undefined
      ? {}
      : { transcript: { runIds: command.transcript.runIds } }),
    ...(command.expiry === undefined ? {} : { expiry: command.expiry }),
    ...(command.passphrase === undefined ? {} : { passphrase: command.passphrase }),
    ...(command.budgetCapUsd === undefined ? {} : { budgetCapUsd: command.budgetCapUsd }),
  };
}

/**
 * `/api/shares/**` — spec §5.13. A share is a snapshot of an agent, session, project or skill
 * that the workspace, or the public through a `/p/<token>` link, may open. The workspace's
 * sharing policy (`workspaces.sharingPolicy`) decides whether a public share may be published.
 */
export class SharesClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /** The caller's own shares, or every share of the workspace for an Owner or Admin. */
  public async list(options: RequestOptions = {}): Promise<readonly ShareListItem[]> {
    const response = await this.#http.json({
      operation: 'shares.list',
      method: 'GET',
      path: '/api/shares',
      expect: [200],
      schema: ShareListResponseSchema,
      signal: options.signal,
    });
    return response.shares;
  }

  /**
   * Publish a share of a subject the caller may share. `400 invalid_share` names what the route
   * refused: a field outside the contract, an option the subject type does not take, a public
   * share while the workspace's policy has public sharing off, `runnable` mode, or a `transcript`
   * naming a run outside the shared session.
   *
   * The command is sent exactly as given — the server owns every default (`mode`, `expiry`, the
   * runnable budget) and the share's content.
   */
  public publish(
    command: PublishShareCommand,
    options: RequestOptions = {},
  ): Promise<ShareResource> {
    return this.#http.json({
      operation: 'shares.publish',
      method: 'POST',
      path: '/api/shares',
      body: publishBody(command),
      expect: [201],
      schema: ShareResourceSchema,
      signal: options.signal,
    });
  }

  /**
   * Revoke a share: its link stops resolving at once. `404 share_not_found` for an id the
   * workspace does not hold; otherwise no body.
   */
  public async revoke(shareId: string, options: RequestOptions = {}): Promise<void> {
    await this.#http.json({
      operation: 'shares.revoke',
      method: 'DELETE',
      path: `/api/shares/${segment(shareId)}`,
      expect: [204],
      schema: NoContentSchema,
      signal: options.signal,
    });
  }
}
