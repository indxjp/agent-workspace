/**
 * Renders the store's project file (`infra/agent-store/agent-workspace.yaml`) for one environment:
 *
 *   STORE_GCP_PROJECT=<id> STORE_DOMAIN=<host> STORE_ALERTS_EMAIL=<address> \
 *   STORE_IMAGE_STORE=<repo>@sha256:<digest> STORE_IMAGE_CRM=... STORE_IMAGE_SERVICE_DESK=... \
 *   STORE_IMAGE_WIKI=... STORE_IMAGE_TEAM_CHAT=... [STORE_SETTINGS_JSON='{"AW_DEMO_...":"..."}'] \
 *   [STORE_APPS_WORKSPACE_ID=<uuid>] [STORE_API_KEY_SECRET_<APP>=<secret id>] \
 *   [STORE_OIDC_ISSUER=<https url> STORE_OIDC_CLIENT_ID=<client id>] \
 *   [STORE_APP_OIDC_CLIENT_ID_<APP>=<client id> STORE_APP_CLIENT_ID_<APP>=<endpoint client id>] \
 *   node tests/store/deploy/render.ts <out-dir>
 *
 * Every value is written inside a single-quoted YAML scalar of the template: a quote is doubled (the
 * only escape a single-quoted scalar has) and a control character is refused, so no value can end
 * the scalar, fold onto another line or add a key.
 * A template line that holds optional variables (the apps' workspace id, API key secret ids and
 * sign-in client ids, the platform's issuer) is dropped when they are all unset or empty, so the
 * first deploy renders before the workspace exists; a line with only some of them set is refused.
 * The result is read with the SDK's project reader, so a value the schema refuses (a bad project id,
 * a tag instead of a digest, a setting the project file may not set) stops the render. A value that
 * is not set stops it too, and the message names the variable and never prints a value.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { API_KEY_PREFIX } from '@indx-workspace/contracts/api-keys';
import { PROJECT_WEB_SETTINGS } from '@indx-workspace/contracts/project-file';
import { OAUTH_CLIENT_SECRET_PREFIX } from '@indx-workspace/contracts/token-exchange';
import { parseProjectFile } from '@indx-workspace/sdk/project';

export const TEMPLATE_PATH = fileURLToPath(
  new URL('../../../infra/agent-store/agent-workspace.yaml', import.meta.url),
);

/** What the render refuses with; the message names a variable or a field, never a value. */
export class RenderRefusal extends Error {}

const SETTINGS_PLACEHOLDER = 'STORE_WEB_SETTINGS';

/** Variables the render may leave unset; the template line that holds one is then left out. */
const OPTIONAL =
  /^STORE_(?:APPS_WORKSPACE_ID|API_KEY_SECRET_[A-Z_]+|OIDC_ISSUER|OIDC_CLIENT_ID|APP_OIDC_CLIENT_ID_[A-Z_]+|APP_CLIENT_ID_[A-Z_]+)$/u;
/** The client id variables: a GitHub variable, so a secret pasted into one is refused. */
const CLIENT_ID = /^STORE_(?:OIDC_CLIENT_ID|APP_OIDC_CLIENT_ID_[A-Z_]+|APP_CLIENT_ID_[A-Z_]+)$/u;
/** Secret prefixes a client id never starts with: an API key, an endpoint client's or Google's secret. */
const SECRET_PREFIXES = [API_KEY_PREFIX, OAUTH_CLIENT_SECRET_PREFIX, 'GOCSPX-'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** A key value is never a secret id; the message names the variable and never the value. */
function checkOptional(name: string, value: string): void {
  if (name === 'STORE_APPS_WORKSPACE_ID' && !UUID.test(value)) {
    throw new RenderRefusal(`${name} must be a workspace id (a UUID)`);
  }
  if (name.startsWith('STORE_API_KEY_SECRET_') && value.startsWith(API_KEY_PREFIX)) {
    throw new RenderRefusal(`${name} must be a Secret Manager secret id, never the key itself`);
  }
  if (CLIENT_ID.test(name) && SECRET_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    throw new RenderRefusal(`${name} must be a client id, never a secret`);
  }
}

/** Whether `line` stays: every optional variable in it set, or none of them (then it is left out). */
function keepLine(line: string, env: Readonly<Record<string, string | undefined>>): boolean {
  const optional = [...line.matchAll(/\$\{([A-Z_]+)\}/gu)]
    .map((match) => match[1] ?? '')
    .filter((name) => OPTIONAL.test(name));
  const unset = optional.filter((name) => (env[name]?.trim() ?? '') === '');
  if (unset.length > 0 && unset.length < optional.length) {
    throw new RenderRefusal(
      `${unset.join(', ')} must be set together with the variables beside it`,
    );
  }
  return unset.length === 0;
}

/** The settings object text: the sign-in link base first, then the caps from STORE_SETTINGS_JSON. */
function webSettings(env: Readonly<Record<string, string | undefined>>, domain: string): string {
  const allowed: readonly string[] = PROJECT_WEB_SETTINGS;
  const raw = env['STORE_SETTINGS_JSON']?.trim() ?? '';
  const given: Record<string, string> = {};
  if (raw !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RenderRefusal('STORE_SETTINGS_JSON is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new RenderRefusal('STORE_SETTINGS_JSON must be a JSON object');
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (!allowed.includes(name)) {
        throw new RenderRefusal(`STORE_SETTINGS_JSON names ${name}, which is not a web setting`);
      }
      if (typeof value !== 'string') {
        throw new RenderRefusal(`STORE_SETTINGS_JSON: ${name} must be a string`);
      }
      given[name] = value;
    }
  }
  return JSON.stringify({
    AW_EMAIL_LINK_BASE_URL: `https://${domain}`,
    ...given,
  });
}

/** Fills the template from `env` and returns the project file text, checked against the schema. */
export function renderProject(
  template: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const domain = env['STORE_DOMAIN']?.trim() ?? '';
  const lines = template.split('\n').filter((line) => keepLine(line, env));
  const text = lines.join('\n').replace(/\$\{([A-Z_]+)\}/gu, (_match, name: string) => {
    if (name === SETTINGS_PLACEHOLDER) return webSettings(env, domain);
    const value = env[name]?.trim() ?? '';
    if (value === '') throw new RenderRefusal(`${name} is not set`);
    if (/\p{Cc}/u.test(value)) throw new RenderRefusal(`${name} holds a control character`);
    if (OPTIONAL.test(name)) checkOptional(name, value);
    // The template quotes each placeholder with single quotes, where '' is a literal quote.
    return value.replaceAll("'", "''");
  });
  try {
    parseProjectFile(text);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new RenderRefusal(`the rendered project file is refused: ${reason}`);
  }
  return text;
}

function main(argv: readonly string[]): number {
  const outDir = argv[0];
  if (outDir === undefined) {
    console.error('usage: node tests/store/deploy/render.ts <out-dir>');
    return 2;
  }
  try {
    const text = renderProject(readFileSync(TEMPLATE_PATH, 'utf8'), process.env);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, 'agent-workspace.yaml'), text);
    console.log(`wrote ${path.join(outDir, 'agent-workspace.yaml')}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'the render failed');
    return error instanceof RenderRefusal ? 2 : 1;
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = main(process.argv.slice(2));
}
