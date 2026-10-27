import { applicationContext } from '../application-context';
import { log } from '../telemetry/logger';

/**
 * Closes a project endpoint client's tool sandbox once its access ends (client, key or OAuth grant
 * revoked), so the secrets it holds do not wait for the idle timeout. Best effort: the revoke
 * has already happened and the handler refuses the revoked client, so a failure is logged and
 * never surfaces. Only the error's class is logged; its text may name an address or a secret.
 * ponytail: a call admitted just before the revoke can reopen the sandbox after this close; the
 * idle timeout then ends it. Re-check the client after `route()` if that ever matters.
 */
export async function closeEndpointToolSandbox(
  workspaceId: string,
  clientId: string,
): Promise<void> {
  try {
    const endpoint = applicationContext()?.toolEndpoint;
    if (endpoint?.kind === 'serving')
      await endpoint.environment.closeSandbox(workspaceId, clientId);
  } catch (error) {
    log.error('[tool-endpoint] the tool sandbox did not close on revoke', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
  }
}
