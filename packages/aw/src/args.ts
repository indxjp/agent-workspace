import { UsageError } from './io.js';

/**
 * Every flag the binary knows, in one table, so the parser can tell a flag that takes a value
 * from a switch without each command re-declaring the grammar. A command reads the ones it
 * documents; an unknown flag is refused before any command runs, and a known flag the command's
 * usage line does not name is refused by `assertSupportedFlags` before the command runs.
 */
const VALUE_FLAGS = [
  // configuration (§7.1)
  'url',
  'profile',
  'timeout',
  // bodies and the handful of scalar fields (§7.3)
  'file',
  'name',
  'role',
  'email',
  'prompt',
  'prompt-file',
  'session',
  'model',
  // issue #319 (ENG-02c): `aw agents create|update --engine <id>` sets the policy arm
  'engine',
  // issue #239 (K-1): `aw agents import <file> --on-missing fail|skip`
  'on-missing',
  // queries
  'limit',
  'cursor',
  // `aw audit list --action <action>`
  'action',
  'path',
  'status',
  'archived',
  // `aw workspaces features list|disable|enable --workspace <id>`
  'workspace',
  'project',
  'after',
  'project-key',
  'subpath',
  // `aw runs outputs <id> --download <dir>`
  'download',
  // `aw runs start <agent> --output-schema <path>`: a JSON Schema file for the run's structured output
  'output-schema',
  // issue #250 (S-6): `aw runs start <agent> --idempotency-key <key>`, sent as Idempotency-Key
  'idempotency-key',
  // issue #236 (SDK-04, S-1): `aw tokens mint --scope run|session --id <id> [--ttl <seconds>]`
  'scope',
  'id',
  'ttl',
  // issue #242 (SDK-10, S-22): `aw workspaces create --slug <slug>`
  'slug',
  // issue #452 (S1-14): `aw push --summary <text>`, `aw agents versions create --summary <text>`
  'summary',
  // issue #620: `aw feedback --since 7d`
  'since',
  // issue #799: `aw eval run --min-score <0..1> --junit <file> --baseline <evaluationId>`
  'min-score',
  'junit',
  'baseline',
  // issue #621: `aw deploy production --infra <dir>` names the gcp-cloudrun module checkout
  'infra',
  // issue #665: `aw runs rate <id> --down --comment <text>`
  'comment',
  // issue #698: `aw eval add "<input>" --expect-tool <name>`
  'expect-tool',
  // issue #689: `aw init` answers a setup question by flag (`agent` and `engine` are above)
  'theme',
  'sandbox',
  // BH061-012: `aw dev --port <n>`
  'port',
  'provider',
  'model-base-url',
  'tools',
  'openapi',
  'permissions',
  'title',
  'color',
  // ADR-0160 D5: `aw init --features chat,files` names the features the deployment installs
  'features',
  // #879: `aw init --answers <file>` reads the setup answers from a YAML or JSON file
  'answers',
  // issue #697: `aw chat --agent-version <n> | --env local|production` (`--version` is aw's own)
  'agent-version',
  'env',
  // issue #1850: `aw agents new --from-prompt <text>` starts a Builder chat
  'from-prompt',
  // issue #800: `aw tool call <name> --input <json>`
  'input',
  // issue #949: `aw endpoint-clients create --kind mcp-project|a2a-agent`, `keys create --expires-at <iso>`
  'kind',
  'expires-at',
  // ADR-0156: `aw triggers create|update --subject <s>` names the caller its runs act for
  'subject',
  // ADR-0133: aw platforms export|import|publish
  'platform',
  'out',
  'from',
  // issue #1692: `aw storage connections create --storage-url <url> --credential-file <path|->`;
  // `--url` is already the control plane's, so the bucket's URL has its own name
  'storage-url',
  'credential-file',
  // issue #1850: `aw agents export <id> --format json|ts`
  'format',
  // issue #250 (N-3): `aw webhooks create --webhook-url <url>`; `--url` is the control plane's,
  // as for `--storage-url`
  'webhook-url',
] as const;

const SWITCH_FLAGS = [
  'api-key-stdin',
  'value-stdin',
  'json',
  'jsonl',
  'raw',
  'quiet',
  'help',
  'version',
  'recursive',
  'direct',
  // issue #1664: `aw files download <path> --link [--ttl <seconds>]` prints a signed link instead
  'link',
  'wait',
  'follow',
  'interrupt-on-cancel',
  // issue #393: `aw runs start --wait|--follow --fail-on-error` exits 1 on a failed run
  'fail-on-error',
  // S-5: `aw sessions list|audit list --all` walks every page
  'all',
  // issue #451 (S1-13): `aw init --yes` writes without asking
  'yes',
  // issue #621: `aw deploy <env> --plan` says the default out loud; `--plan --yes` is refused
  'plan',
  // issue #620: `aw feedback --negative` lists thumbs-down ratings only
  'negative',
  // issue #665: `aw runs rate <id> --up|--down`
  'up',
  'down',
  // issue #692: `aw dev --verbose` streams the runtime log
  'verbose',
  // UX-C (#760): `aw dev --open` opens the chat page without asking, `--no-open` never asks
  'open',
  'no-open',
  // ADR-0133: `aw platforms export --strict` exits 5 when a field was dropped
  'strict',
  // ADR-0133 D11: `aw platforms publish --experimental` unlocks executors the vendor marks preview
  'experimental',
  // issue #1692: `aw storage connections create --write-allowed` lets grants include write
  'write-allowed',
  // issue #1850: `aw agents export <id> --format ts --force` replaces files it would write
  'force',
] as const;

/**
 * Flags that may be given more than once, each occurrence adding to a list rather than being
 * refused as a repeat — `agents create`'s `--skill`/`--connector`/`--grant-file` (S-13/K-2,
 * issue #234). A name here must not also appear in {@link VALUE_FLAGS} or {@link SWITCH_FLAGS};
 * `assertDisjointFlagNames` below checks that once, at module load.
 */
const REPEATABLE_VALUE_FLAGS = [
  'skill',
  'connector',
  'grant-file',
  // issue #1539: `aw runs start <agent> --file-scope <path> [--file-scope …]`
  'file-scope',
  // the storage design, §07 (US-STO-06): `aw runs start <agent> --attach <file> [--attach …]`
  'attach',
  // issue #698: `aw eval add "<input>" --expect-contains <text>`, once per needle
  'expect-contains',
  // issue #949: `aw endpoint-clients create --agent <name> [--agent …] [--tool <name> …]`; the
  // single-agent commands read `--agent` through `singleValue`, which refuses a repeat
  'agent',
  'tool',
  // issue #971: `aw endpoint-clients update <id> --redirect-uri <uri> [--redirect-uri …]`
  'redirect-uri',
  // issue #1692: `aw storage connections create --allow <prefix> [--allow …]`
  'allow',
  // issue #250 (N-3): `aw webhooks create --webhook-url <url> --event <type> [--event …]`
  'event',
] as const;

export type ValueFlag = (typeof VALUE_FLAGS)[number];
export type SwitchFlag = (typeof SWITCH_FLAGS)[number];
export type RepeatableValueFlag = (typeof REPEATABLE_VALUE_FLAGS)[number];

const VALUE_FLAG_SET: ReadonlySet<string> = new Set(VALUE_FLAGS);
const SWITCH_FLAG_SET: ReadonlySet<string> = new Set(SWITCH_FLAGS);
const REPEATABLE_VALUE_FLAG_SET: ReadonlySet<string> = new Set(REPEATABLE_VALUE_FLAGS);

/** Every flag name lives in exactly one of the three tables — checked once, at module load. */
function assertDisjointFlagNames(): void {
  const seen = new Map<string, string>();
  const tables: readonly (readonly [string, ReadonlySet<string>])[] = [
    ['VALUE_FLAGS', VALUE_FLAG_SET],
    ['SWITCH_FLAGS', SWITCH_FLAG_SET],
    ['REPEATABLE_VALUE_FLAGS', REPEATABLE_VALUE_FLAG_SET],
  ];
  for (const [tableName, names] of tables) {
    for (const name of names) {
      const already = seen.get(name);
      if (already !== undefined) {
        throw new Error(`--${name} is declared in both ${already} and ${tableName}`);
      }
      seen.set(name, tableName);
    }
  }
}
assertDisjointFlagNames();

/**
 * A credential must never be a flag value: it would land in shell history and in every process
 * listing. The refusal is deliberate and names the three ways a key may arrive.
 */
export const API_KEY_FLAG_REFUSED =
  '--api-key is not accepted: pass the key with --api-key-stdin, AGENT_WORKSPACE_API_KEY, or a profile whose apiKeyRef names an environment variable';

export interface ParsedArguments {
  /** The words that are not flags, in order: the command path first, then its arguments. */
  readonly positionals: readonly string[];
  readonly values: ReadonlyMap<ValueFlag, string>;
  readonly switches: ReadonlySet<SwitchFlag>;
  /** Every occurrence of a repeatable flag, in the order given. A flag never given has no key. */
  readonly repeatableValues: ReadonlyMap<RepeatableValueFlag, readonly string[]>;
}

function isValueFlag(name: string): name is ValueFlag {
  return VALUE_FLAG_SET.has(name);
}

function isSwitchFlag(name: string): name is SwitchFlag {
  return SWITCH_FLAG_SET.has(name);
}

function isRepeatableValueFlag(name: string): name is RepeatableValueFlag {
  return REPEATABLE_VALUE_FLAG_SET.has(name);
}

/** `--name`, `--name=value`, `--name value`, `-h`, `-p <text>`, a bare `-` (stdin) and `--` (end of flags). */
export function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  const values = new Map<ValueFlag, string>();
  const switches = new Set<SwitchFlag>();
  const repeatableValues = new Map<RepeatableValueFlag, string[]>();
  let index = 0;
  while (index < argv.length) {
    // `-p` is the short spelling of `--prompt` (issue #697, `aw chat -p`).
    const token = argv[index] === '-p' ? '--prompt' : argv[index];
    index += 1;
    if (token === undefined) break;
    if (token === '--') {
      positionals.push(...argv.slice(index));
      break;
    }
    if (token === '-h') {
      switches.add('help');
      continue;
    }
    if (!token.startsWith('--')) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf('=');
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);
    if (name === 'api-key') throw new UsageError(API_KEY_FLAG_REFUSED);
    if (isSwitchFlag(name)) {
      if (inlineValue !== null) throw new UsageError(`--${name} takes no value`);
      switches.add(name);
      continue;
    }
    if (isRepeatableValueFlag(name)) {
      const next = argv[index];
      const value = inlineValue ?? (next !== undefined && !next.startsWith('--') ? next : null);
      if (value === null) throw new UsageError(`--${name} needs a value`);
      if (inlineValue === null) index += 1;
      const existing = repeatableValues.get(name);
      if (existing === undefined) repeatableValues.set(name, [value]);
      else existing.push(value);
      continue;
    }
    if (!isValueFlag(name)) throw new UsageError(`unknown flag --${name}`);
    if (values.has(name)) throw new UsageError(`--${name} was given more than once`);
    const next = argv[index];
    const value = inlineValue ?? (next !== undefined && !next.startsWith('--') ? next : null);
    if (value === null) throw new UsageError(`--${name} needs a value`);
    if (inlineValue === null) index += 1;
    values.set(name, value);
  }
  return { positionals, values, switches, repeatableValues };
}
