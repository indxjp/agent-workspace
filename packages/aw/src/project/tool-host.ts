import type { ConnectorResource } from '@indx-workspace/contracts/connectors';
import {
  AW_DEV_TOOLS_CONNECTOR,
  TOOL_SANDBOX_CONNECTOR_URL,
} from '@indx-workspace/contracts/tool-connectors';

import type { LoadedCodeTool } from './load.js';
import { problemsFromError, type ProjectProblem } from './problems.js';
import type { ProjectRunOptions } from './check.js';

type Client = ProjectRunOptions['client'];

/** What `createToolHost` makes: an mcp http connector with no credential at the reserved URL. */
function isToolHost(connector: ConnectorResource): boolean {
  return (
    connector.kind !== 'openapi' &&
    connector.kind !== 'postgres' &&
    connector.transport === 'http' &&
    connector.authType === 'none' &&
    !connector.hasCredential &&
    connector.url === TOOL_SANDBOX_CONNECTOR_URL
  );
}

/**
 * What `aw dev` registers (ADR-0115): an mcp http connector with no credential at its tool host's
 * loopback URL, which changes on every start.
 */
export function madeByAwDev(connector: ConnectorResource): boolean {
  return (
    connector.kind !== 'openapi' &&
    connector.kind !== 'postgres' &&
    connector.transport === 'http' &&
    connector.authType === 'none' &&
    !connector.hasCredential &&
    connector.url !== null &&
    URL.canParse(connector.url) &&
    new URL(connector.url).hostname === '127.0.0.1'
  );
}

/**
 * ADR-0118 TS3: a version listing code tools names the connector `aw-dev-tools`, which a deployment
 * does not have until a push makes it. Reads the workspace's connectors: `create` is whether the
 * push must make it. One this push did not make (another transport, a credential, another URL) is a
 * `tool_host_connector_conflict`, never re-pointed, so its stored auth never reaches the sandbox.
 * One `aw dev` registered is its own tool host (BH061-001): `dev` is set, and the push pins no
 * bundle, as `aw dev` itself does (TS7), since that runtime serves code tools from source.
 */
export async function planToolHost(
  options: { readonly client: Client; readonly signal: AbortSignal },
  codeTools: readonly LoadedCodeTool[],
): Promise<{
  readonly problems: readonly ProjectProblem[];
  readonly create: boolean;
  readonly dev: boolean;
}> {
  const [first] = codeTools;
  if (first === undefined) return { problems: [], create: false, dev: false };
  try {
    const existing = (await options.client.connectors.list({ signal: options.signal })).find(
      (connector) => connector.name === AW_DEV_TOOLS_CONNECTOR,
    );
    if (existing === undefined) return { problems: [], create: true, dev: false };
    if (isToolHost(existing)) return { problems: [], create: false, dev: false };
    if (madeByAwDev(existing)) return { problems: [], create: false, dev: true };
    return {
      create: false,
      dev: false,
      problems: [
        {
          file: first.file,
          status: null,
          code: 'tool_host_connector_conflict',
          details: [`connector:${AW_DEV_TOOLS_CONNECTOR}`],
          hint: `a connector named ${AW_DEV_TOOLS_CONNECTOR} that aw push did not create already exists; aw push will not re-point it, so rename or delete it, then push again`,
        },
      ],
    };
  } catch (error) {
    return { problems: problemsFromError(error, first.file, []), create: false, dev: false };
  }
}

/** Make the connector {@link planToolHost} found absent. */
export async function createToolHost(
  options: { readonly client: Client; readonly signal: AbortSignal },
  file: string,
): Promise<readonly ProjectProblem[]> {
  try {
    await options.client.connectors.create(
      { name: AW_DEV_TOOLS_CONNECTOR, transport: 'http', url: TOOL_SANDBOX_CONNECTOR_URL },
      { signal: options.signal },
    );
    return [];
  } catch (error) {
    return problemsFromError(error, file, []);
  }
}
