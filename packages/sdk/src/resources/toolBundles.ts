import {
  ToolBundleResponseSchema,
  UploadToolBundleResponseSchema,
  type ToolBundle,
  type UploadToolBundleRequest,
  type UploadToolBundleResponse,
} from '@indx-workspace/contracts/agent-versions';

import { segment, type HttpClient, type RequestOptions } from '../http.js';

/**
 * `/api/tool-bundles/**` — issue #790 (ADR-0118 TS1). A code tool is one bundled ES module,
 * content-addressed by the SHA-256 of its bytes: upload it once, pin the digest in an agent
 * version's `toolBundles`, and the version save refuses (`422 tool_bundle_unknown`) a digest the
 * workspace does not hold.
 */
export class ToolBundlesClient {
  readonly #http: HttpClient;

  public constructor(http: HttpClient) {
    this.#http = http;
  }

  /**
   * Store the bundle's bytes (base64 in `contentBase64`). The same bytes answer the same digest with `created: false` and
   * write nothing. `400 invalid_tool_bundle`, `413 tool_bundle_too_large` (over 8 MiB),
   * `503 tool_bundles_not_configured` when the deployment has no object store.
   */
  public async upload(
    input: UploadToolBundleRequest,
    options: RequestOptions = {},
  ): Promise<UploadToolBundleResponse> {
    const body: UploadToolBundleRequest = { contentBase64: input.contentBase64 };
    return this.#http.json({
      operation: 'toolBundles.upload',
      method: 'POST',
      path: '/api/tool-bundles',
      body,
      expect: [200, 201],
      schema: UploadToolBundleResponseSchema,
      signal: options.signal,
    });
  }

  /** `404 tool_bundle_not_found` for a digest the workspace does not hold, malformed or not. */
  public async get(digest: string, options: RequestOptions = {}): Promise<ToolBundle> {
    const response = await this.#http.json({
      operation: 'toolBundles.get',
      method: 'GET',
      path: `/api/tool-bundles/${segment(digest)}`,
      expect: [200],
      schema: ToolBundleResponseSchema,
      signal: options.signal,
    });
    return response.bundle;
  }
}
