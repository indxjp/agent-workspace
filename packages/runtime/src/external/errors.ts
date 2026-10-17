/** Codes a driver answers when it refuses a request by name instead of failing. */
export type RuntimeRefusalCode =
  'network_policy_unsupported' | 'run_spec_unsupported' | 'provider_credential_required';

/**
 * A request the driver understood and refuses by name (spec §14.5, ADR-0120 LC4/LC6). Unlike an
 * infrastructure failure it carries a stable `code`, so the runner manager can answer `422` with it
 * rather than a nameless `500`. The message never carries a credential or a provider response.
 */
export class RuntimeRefusalError extends Error {
  public constructor(
    public readonly code: RuntimeRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'RuntimeRefusalError';
  }
}
