import type { AgentVersionBody } from '@indx-workspace/contracts/agent-versions';

export const DEFINITION_SECTIONS = [
  'model',
  'runtime',
  'resources',
  'permissions',
  'instructions',
  'tools',
  'policy',
  'subagents',
  'knowledge',
  'description',
] as const;
export type DefinitionSection = (typeof DEFINITION_SECTIONS)[number];

export interface DefinitionChange {
  readonly section: DefinitionSection;
  readonly path: string;
  readonly before?: unknown;
  /** `undefined` when the field was removed. */
  readonly after: unknown;
}

type Leaves = ReadonlyMap<string, unknown>;

const AGENT = 'definition.agent';
const RESOURCES = 'definition.resources';
const POLICY_TOOLS = 'definition.policy.tools';

/** The `policy.tools` fields the `policy` section lists; the rest of `policy` is not diffed. */
const LISTED_POLICY_TOOLS = [
  'base',
  'deny',
  'permissionMode',
  'allowDangerouslySkipPermissions',
  'autoApprove',
];

/**
 * Every section flattened to `path -> primitive`, so two bodies compare key by key. A section the
 * union gains without an extractor here fails typecheck. `policy` lists only the tool-rules arm's
 * `base`, `deny`, `permissionMode`, `allowDangerouslySkipPermissions` and `autoApprove`; {@link uncoveredKeys}
 * names what no section lists.
 */
const LEAVES: Readonly<Record<DefinitionSection, (body: AgentVersionBody) => Leaves>> = {
  model: ({ definition: { agent } }) =>
    new Map<string, unknown>([
      [`${AGENT}.model`, agent.model],
      [`${AGENT}.modelConnectionName`, agent.modelConnectionName],
    ]),
  runtime: ({ definition: { agent } }) =>
    new Map<string, unknown>([[`${AGENT}.runtimeProfileName`, agent.runtimeProfileName]]),
  resources: ({ definition: { resources } }) =>
    new Map<string, unknown>([
      // The contracts schema does not make file paths unique, so a repeat is keyed `#2`, `#3`, ...
      ...resources.files.map((file, index): [string, unknown] => {
        const repeat = resources.files.slice(0, index).filter((f) => f.path === file.path).length;
        const suffix = repeat === 0 ? '' : `#${repeat + 1}`;
        return [`${RESOURCES}.files[${JSON.stringify(file.path)}]${suffix}`, file.access];
      }),
      ...resources.skills.map((name): [string, unknown] => [
        `${RESOURCES}.skills[${JSON.stringify(name)}]`,
        true,
      ]),
      ...Object.entries(resources.skillRevisions ?? {}).map((entry): [string, unknown] => [
        `${RESOURCES}.skills[${JSON.stringify(entry[0])}].revision`,
        entry[1],
      ]),
      ...resources.connectors.map((name): [string, unknown] => [
        `${RESOURCES}.connectors[${JSON.stringify(name)}]`,
        true,
      ]),
    ]),
  permissions: ({ definition: { agent } }) =>
    new Map<string, unknown>(
      Object.entries(agent.permissions).map(([key, enabled]) => [
        `${AGENT}.permissions.${key}`,
        enabled,
      ]),
    ),
  instructions: ({ definition: { agent } }) =>
    new Map<string, unknown>([[`${AGENT}.instructions`, agent.instructions]]),
  tools: ({ toolBundles }) =>
    new Map<string, unknown>(
      (toolBundles ?? []).flatMap((bundle): [string, unknown][] => {
        const base = `toolBundles[${JSON.stringify(bundle.tool)}]`;
        return [
          [base, bundle.digest],
          [`${base}.timeoutMs`, bundle.timeoutMs],
          // Names only: a secret's value is never in the body.
          ...(bundle.allowedDomains ?? []).map((host): [string, unknown] => [
            `${base}.allowedDomains[${JSON.stringify(host)}]`,
            true,
          ]),
          ...(bundle.secrets ?? []).map((name): [string, unknown] => [
            `${base}.secrets[${JSON.stringify(name)}]`,
            true,
          ]),
        ];
      }),
    ),
  policy: ({ definition: { policy } }) =>
    new Map<string, unknown>(
      'tools' in policy
        ? [
            ...(policy.tools.base === 'claude_code_preset'
              ? [[`${POLICY_TOOLS}.base`, policy.tools.base] as [string, unknown]]
              : policy.tools.base.map((rule): [string, unknown] => [
                  `${POLICY_TOOLS}.base[${JSON.stringify(rule)}]`,
                  true,
                ])),
            ...policy.tools.deny.map((rule): [string, unknown] => [
              `${POLICY_TOOLS}.deny[${JSON.stringify(rule)}]`,
              true,
            ]),
            [`${POLICY_TOOLS}.permissionMode`, policy.tools.permissionMode],
            [
              `${POLICY_TOOLS}.allowDangerouslySkipPermissions`,
              policy.tools.allowDangerouslySkipPermissions,
            ],
            ...policy.tools.autoApprove.map((rule): [string, unknown] => [
              `${POLICY_TOOLS}.autoApprove[${JSON.stringify(rule)}]`,
              true,
            ]),
          ]
        : [],
    ),
  subagents: ({ subagents = [] }) =>
    new Map<string, unknown>(
      subagents.map(({ name }): [string, unknown] => [`subagents[${JSON.stringify(name)}]`, true]),
    ),
  knowledge: ({ knowledge = [] }) =>
    new Map<string, unknown>(
      knowledge.flatMap((source): [string, unknown][] =>
        source.kind === 'files'
          ? source.paths.map((path): [string, unknown] => [
              `knowledge.files[${JSON.stringify(path)}]`,
              true,
            ])
          : [[`knowledge.connectors[${JSON.stringify(source.name)}]`, true]],
      ),
    ),
  description: ({ description }) =>
    new Map<string, unknown>(description === undefined ? [] : [['description', description]]),
};

/** What `after` changes relative to `before` (`null` for a new agent), ordered by section then path. */
export function diffBodies(
  before: AgentVersionBody | null,
  after: AgentVersionBody,
): DefinitionChange[] {
  return DEFINITION_SECTIONS.flatMap((section) => {
    const was: Leaves = before === null ? new Map() : LEAVES[section](before);
    const now = LEAVES[section](after);
    const paths = [...new Set([...was.keys(), ...now.keys()])].sort();
    return paths.flatMap((path): DefinitionChange[] => {
      if (was.has(path) && now.has(path) && was.get(path) === now.get(path)) return [];
      return [
        {
          section,
          path,
          ...(was.has(path) ? { before: was.get(path) } : {}),
          after: now.get(path),
        },
      ];
    });
  });
}

const omit = (value: object, keys: readonly string[]): [string, unknown][] =>
  Object.entries(value).filter(([key]) => !keys.includes(key));

/** What `diffBodies` does not list of a body, by top-level key; empty values dropped. */
function unlisted(body: AgentVersionBody | null): Map<string, string> {
  if (body === null) return new Map();
  const { definition, toolBundles = [], ...top } = body;
  const { agent, resources, policy } = definition;
  const rest: [string, unknown][] = [
    ...omit(top, ['description', 'subagents', 'knowledge']),
    ...omit(definition, ['apiVersion', 'kind', 'agent', 'resources', 'policy']),
    [
      'policy',
      'tools' in policy
        ? { ...policy, tools: Object.fromEntries(omit(policy.tools, LISTED_POLICY_TOOLS)) }
        : policy,
    ],
    ...omit(agent, [
      'model',
      'modelConnectionName',
      'runtimeProfileName',
      'instructions',
      'permissions',
    ]),
    ...omit(resources, ['files', 'skills', 'skillRevisions', 'connectors']),
    // Each bundle's other fields under its tool's name, so a field that moves between tools shows.
    ...toolBundles.map((bundle): [string, unknown] => [
      `toolBundles[${JSON.stringify(bundle.tool)}]`,
      Object.fromEntries(
        omit(bundle, ['tool', 'digest', 'timeoutMs', 'secrets', 'allowedDomains']),
      ),
    ]),
  ];
  const json = rest.map(([key, part]): [string, string] => [key, JSON.stringify(part) ?? '']);
  return new Map(json.filter(([, text]) => !['', '[]', '{}'].includes(text)));
}

/**
 * The top-level keys of `after` that differ from `before` outside what {@link diffBodies} lists, so
 * a caller can say "also changes" without printing a covered field twice.
 */
export function uncoveredKeys(before: AgentVersionBody | null, after: AgentVersionBody): string[] {
  const was = unlisted(before);
  const now = unlisted(after);
  return [...new Set([...was.keys(), ...now.keys()])].filter(
    (key) => was.get(key) !== now.get(key),
  );
}
