import { z } from 'zod';

import { SKILL_NAME_PATTERN } from './skills.js';
import { urlCarriesCredential } from './url-credential.js';

/**
 * The name-key grammar: lower-case kebab, 1–64 characters, no hyphen at either end. It is the
 * skills' grammar, named for what a project, an agent or a surface uses it for — one pattern, so
 * the two can never disagree.
 */
export const NAME_KEY_PATTERN = SKILL_NAME_PATTERN;

/** The most entries a project file's `models` or `connectors` map may hold (issue #524). */
export const PROJECT_RESOURCE_MAP_MAX_ENTRIES = 64;

/** The longest `baseUrl` or connector `url` a project file may name, in characters. */
export const PROJECT_URL_MAX_LENGTH = 2048;

/** The fixed refusal for a credential in a URL; it never echoes the value. */
const URL_CREDENTIAL_MESSAGE =
  'must not carry a credential; name it as a secret reference { secret: NAME } (C10)';

/**
 * Refuses a URL that carries a credential ({@link urlCarriesCredential}): a user name or password,
 * or a credential query parameter. A credential is a `{ secret: NAME }` reference (C10), so a
 * committed file never holds its value. It runs only on a value the URL check accepted.
 */
function refuseUrlCredential(value: string, context: z.RefinementCtx<string>): void {
  if (!URL.canParse(value)) return;
  if (urlCarriesCredential(new URL(value))) {
    context.addIssue({ code: 'custom', message: URL_CREDENTIAL_MESSAGE });
  }
}

/**
 * An `http:` or `https:` URL, at most {@link PROJECT_URL_MAX_LENGTH} characters, with no
 * credential in it (no user name or password, and no credential query parameter).
 */
export const ProjectHttpUrlSchema = z
  .url({ protocol: /^https?$/u, error: 'must be an http:// or https:// URL', abort: true })
  .max(PROJECT_URL_MAX_LENGTH, { abort: true })
  .superRefine(refuseUrlCredential);

/**
 * An `https:` origin — no path, query or fragment — at most {@link PROJECT_URL_MAX_LENGTH}
 * characters, with no credential in it: where a deployed environment is served.
 */
export const ProjectOriginUrlSchema = z
  .url({ protocol: /^https$/u, error: 'must be an https:// URL', abort: true })
  .max(PROJECT_URL_MAX_LENGTH, { abort: true })
  .superRefine((value, context) => {
    if (!URL.canParse(value)) return;
    const url = new URL(value);
    if (urlCarriesCredential(url)) {
      context.addIssue({ code: 'custom', message: URL_CREDENTIAL_MESSAGE });
    } else if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      context.addIssue({
        code: 'custom',
        message:
          'must be an origin only, such as https://agents.example.com; no path, query or fragment',
      });
    }
  });

/** The reserved key a parser would drop from a map rather than check (see `projectResourceMap`). */
const PROTOTYPE_KEY = '__proto__';

/**
 * Refuses an own `__proto__` key. A YAML or JSON reader keeps it as an own key, but Zod's record
 * skips it without checking its name or its value, so the entry would be accepted and dropped —
 * a credential string or a `stdio` connector under it would pass unseen. It is refused here, at
 * its own path, before the record parses the map.
 */
function refusePrototypeKey(value: unknown, context: z.RefinementCtx<unknown>): void {
  if (typeof value === 'object' && value !== null && Object.hasOwn(value, PROTOTYPE_KEY)) {
    context.addIssue({
      code: 'custom',
      path: [PROTOTYPE_KEY],
      message: 'must be lower-case kebab, 1-64 characters',
    });
  }
}

/**
 * A `models`, `connectors` or `environments.production.apps` map: name keys in {@link NAME_KEY_PATTERN}, bounded in size. The map
 * is a pipe whose first step only refuses an own `__proto__` key (see {@link refusePrototypeKey})
 * and transforms nothing, so the editor schema is still the record's.
 */
export function projectResourceMap<Value extends z.ZodType>(value: Value) {
  const map = z
    .record(z.string().regex(NAME_KEY_PATTERN, 'must be lower-case kebab, 1-64 characters'), value)
    .readonly()
    .refine(
      (entries) => Object.keys(entries).length <= PROJECT_RESOURCE_MAP_MAX_ENTRIES,
      `must hold at most ${String(PROJECT_RESOURCE_MAP_MAX_ENTRIES)} entries`,
    );
  return z.unknown().superRefine(refusePrototypeKey).pipe(map);
}
