/**
 * `aw-app recipe-on '<cron>' [--tz <iana>]` (issue #1514): whether a schedule can start a recipe,
 * for `aw generate recipe --on 'schedule:<cron>'`. `aw` may import neither the app kit nor croner,
 * so it spawns this bin from the project's own install, as it spawns `aw-app sql`.
 *
 * The check is `defineRecipe`'s own: the same five-field rule, croner's parse and the IANA time
 * zone test the generated `recipes/<name>.ts` meets when the app loads. Pure apart from its two
 * output streams.
 */
import { DefinitionError } from '@indx-workspace/sdk/define';

import { defineRecipe, schedule } from '../recipe.js';
import { AW_APP_EXIT, type AwAppIo } from './sql.js';

export const RECIPE_ON_USAGE = "usage: aw-app recipe-on '<cron>' [--tz <iana-time-zone>]\n";

/** The longest cron or time zone the bin reads. */
const ARGUMENT_MAX_LENGTH = 200;

/** The cron and the time zone of the command line, or `undefined` when it is not that. */
function recipeOnArguments(
  argv: readonly string[],
): { readonly cron: string; readonly timezone: string } | undefined {
  const rest = [...argv];
  let timezone: string | undefined;
  const positionals: string[] = [];
  while (rest.length > 0) {
    const token = rest.shift() ?? '';
    if (token === '--tz' && timezone === undefined && rest.length > 0) timezone = rest.shift();
    else if (token.startsWith('--tz=') && timezone === undefined) timezone = token.slice(5);
    else if (token.startsWith('--')) return undefined;
    else positionals.push(token);
  }
  const [cron] = positionals;
  if (cron === undefined || positionals.length !== 1) return undefined;
  return { cron, timezone: timezone ?? 'UTC' };
}

/**
 * Runs `aw-app recipe-on <argv>`: exit 0 and `ok` on stdout when `schedule(cron, tz)` can start a
 * recipe; 1 with every reason on stderr when it cannot; 2 with the usage for a misused line.
 */
export function runAwAppRecipeOn(argv: readonly string[], io: AwAppIo): number {
  const parsed = recipeOnArguments(argv);
  if (parsed === undefined) {
    io.stderr(RECIPE_ON_USAGE);
    return AW_APP_EXIT.usage;
  }
  if (parsed.cron.length > ARGUMENT_MAX_LENGTH || parsed.timezone.length > ARGUMENT_MAX_LENGTH) {
    io.stderr('error: the schedule is too long\n');
    return AW_APP_EXIT.refused;
  }
  try {
    defineRecipe({
      name: 'schedule-check',
      on: schedule(parsed.cron, parsed.timezone),
      run: () => Promise.resolve(),
    });
  } catch (error) {
    if (!(error instanceof DefinitionError)) throw error;
    const reasons = error.issues.map(
      (issue) => `${issue.path.replace(/^on\./u, '')} ${issue.message}`,
    );
    io.stderr(`error: the schedule is refused: ${reasons.join('; ')}\n`);
    return AW_APP_EXIT.refused;
  }
  io.stdout('ok\n');
  return AW_APP_EXIT.ok;
}
