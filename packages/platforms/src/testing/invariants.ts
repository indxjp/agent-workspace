import {
  FieldVerdictSchema,
  HOSTED_PLATFORM_IDS,
  PlatformFileSchema,
  PlatformRefusalSchema,
  type FieldVerdict,
  type PlatformId,
} from '@indx-workspace/contracts/platforms';
import {
  PortableProjectSchema,
  type PortableProject,
} from '@indx-workspace/contracts/portable-agent';

import { compileForPlatform } from '../compile.js';
import { capabilityOfPath, portableFieldPaths } from '../paths.js';
import type { PlatformCompileResult, PlatformTarget } from '../port.js';
import {
  SAMPLE_PORTABLE_PROJECT,
  SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT,
  SAMPLE_PORTABLE_PROJECT_WITH_EXTENSIONS,
} from './sample.js';

/**
 * What a text file must not contain. A `PortableProject` never holds a secret value (ADR-0133 D4),
 * so a match means a translator invented one. Naming a secret reference (`ZENDESK_TOKEN`,
 * `${{ secrets.X }}`, a vault id) is allowed.
 */
export const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/u,
  /\bsk-[A-Za-z0-9]{20,}/u,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
];

/** Structural equality for plain data: primitives, arrays, byte arrays and plain objects. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((byte, index) => byte === b[index])
    );
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a);
  const right = Object.entries(b);
  return (
    left.length === right.length &&
    left.every(
      ([key, value]) =>
        Object.hasOwn(b, key) && deepEqual(value, (b as Record<string, unknown>)[key]),
    )
  );
}

function verdictShapeViolations(report: readonly FieldVerdict[]): string[] {
  return report.flatMap((entry) => {
    if (entry.verdict === 'dropped' && entry.code === undefined) {
      return [`${entry.path} is dropped without a code`];
    }
    if (entry.verdict !== 'dropped' && entry.code !== undefined) {
      return [`${entry.path} is ${entry.verdict} but carries the code ${entry.code}`];
    }
    const parsed = FieldVerdictSchema.safeParse(entry);
    return parsed.success ? [] : [`${entry.path} is not a valid verdict: ${parsed.error.message}`];
  });
}

function reportPathViolations(project: PortableProject, report: readonly FieldVerdict[]): string[] {
  const counts = new Map<string, number>();
  for (const entry of report) counts.set(entry.path, (counts.get(entry.path) ?? 0) + 1);
  const expected = new Set(portableFieldPaths(project));
  const generated = new Set(portableFieldPaths(project, { withGeneratedDescriptions: true }));
  const mappedPaths = new Set(
    report.filter((entry) => entry.verdict === 'mapped').map((entry) => entry.path),
  );
  return [
    ...[...expected]
      .filter((path) => !counts.has(path))
      .map((path) => `${path} has no verdict in the report`),
    ...[...counts]
      .filter(([, count]) => count > 1)
      .map(([path, count]) => `${path} is reported ${count} times`),
    ...[...counts.keys()]
      .filter((path) => !expected.has(path))
      .flatMap((path) => {
        if (!generated.has(path)) return [`${path} is reported but is not a field of the project`];
        return mappedPaths.has(path)
          ? []
          : [`${path} is a generated description and must be reported as mapped`];
      }),
  ];
}

function capabilityViolations(
  target: PlatformTarget,
  project: PortableProject,
  report: readonly FieldVerdict[],
): string[] {
  return report.flatMap((entry) => {
    if (entry.verdict === 'dropped') return [];
    const capability = capabilityOfPath(project, entry.path);
    return capability !== null && target.capabilities[capability] === 'unsupported'
      ? [`${entry.path} is ${entry.verdict} but ${target.id} does not support ${capability}`]
      : [];
  });
}

function platformExtensionViolations(
  target: PlatformTarget,
  report: readonly FieldVerdict[],
): string[] {
  return report.flatMap((entry) => {
    const id = /\.extensions\.platforms\.(.+)$/u.exec(entry.path)?.[1];
    if (id === undefined) return [];
    if (id === target.id) {
      return entry.verdict === 'mapped'
        ? []
        : [`${entry.path} is the target's own and must be mapped`];
    }
    return entry.verdict === 'dropped' && entry.code === 'field_unsupported'
      ? []
      : [`${entry.path} belongs to another platform and must be dropped with field_unsupported`];
  });
}

function fileViolations(files: readonly { path: string; content: unknown }[]): string[] {
  const seen = new Set<string>();
  return files.flatMap((file) => {
    const violations: string[] = [];
    const parsed = PlatformFileSchema.safeParse(file);
    if (!parsed.success) violations.push(`file ${file.path} is invalid: ${parsed.error.message}`);
    if (seen.has(file.path)) violations.push(`file ${file.path} is emitted more than once`);
    seen.add(file.path);
    if (typeof file.content === 'string') {
      for (const pattern of CREDENTIAL_PATTERNS) {
        if (pattern.test(file.content)) {
          violations.push(`file ${file.path} contains a credential matching ${String(pattern)}`);
        }
      }
    }
    return violations;
  });
}

function verdictViolations(
  target: PlatformTarget,
  project: PortableProject,
  result: PlatformCompileResult,
): string[] {
  if (!result.ok) {
    const parsed = PlatformRefusalSchema.safeParse(result.refusal);
    return parsed.success ? [] : [`the refusal is invalid: ${parsed.error.message}`];
  }
  return [
    ...reportPathViolations(project, result.report),
    ...verdictShapeViolations(result.report),
    ...capabilityViolations(target, project, result.report),
    ...platformExtensionViolations(target, result.report),
    ...fileViolations(result.files),
  ];
}

/**
 * Throws one `Error` listing every way `result` breaks the verdict model (ADR-0133 D7): a field
 * with no verdict or two, a dropped field with no code, a verdict that contradicts the target's
 * capabilities, a mishandled platform extension, an invalid or duplicate file, or a credential in
 * a file. It uses no test framework, so a runner, a script and a vitest test can all call it.
 */
export function assertVerdictInvariants(
  target: PlatformTarget,
  project: PortableProject,
  result: PlatformCompileResult,
): void {
  const violations = verdictViolations(target, project, result);
  if (violations.length > 0) {
    throw new Error(`${target.id} breaks the verdict model:\n- ${violations.join('\n- ')}`);
  }
}

const SELF_RUNNING_HOSTED_IDS: readonly PlatformId[] = ['gemini-enterprise'];

function isHosted(id: PlatformId): boolean {
  return (HOSTED_PLATFORM_IDS as readonly PlatformId[]).includes(id);
}

function dropRuleViolations(
  target: PlatformTarget,
  project: PortableProject,
  result: PlatformCompileResult,
): string[] {
  if (!result.ok) return [];
  const verdictOf = new Map(result.report.map((entry) => [entry.path, entry]));
  const mustDrop = (path: string, code: string, why: string): string[] => {
    const entry = verdictOf.get(path);
    return entry?.verdict === 'dropped' && entry.code === code
      ? []
      : [`${path} must be dropped with ${code} (${why})`];
  };
  const violations: string[] = [];
  for (const agent of project.agents) {
    agent.tools.forEach((tool, index) => {
      const path = `${agent.name}.tools.${index}`;
      if (tool.kind === 'mcp' && tool.transport === 'stdio' && isHosted(target.id)) {
        violations.push(
          ...mustDrop(path, 'stdio_mcp_unsupported', 'a hosted platform has no stdio'),
        );
      }
      if (
        tool.kind === 'code' &&
        project.toolEndpoint === undefined &&
        isHosted(target.id) &&
        !SELF_RUNNING_HOSTED_IDS.includes(target.id)
      ) {
        violations.push(
          ...mustDrop(path, 'code_tool_needs_public_mcp', 'there is no public tool endpoint'),
        );
      }
    });
    if (target.capabilities.engine === 'unsupported') {
      if (agent.engine !== undefined) {
        violations.push(
          ...mustDrop(`${agent.name}.engine`, 'field_unsupported', 'the host runs its own loop'),
        );
      }
      for (const id of Object.keys(agent.extensions?.engines ?? {})) {
        violations.push(
          ...mustDrop(
            `${agent.name}.extensions.engines.${id}`,
            'field_unsupported',
            'the host runs its own loop',
          ),
        );
      }
    }
  }
  return violations;
}

function parse(input: unknown): PortableProject {
  return PortableProjectSchema.parse(input);
}

function conformanceViolations(
  target: PlatformTarget,
  label: string,
  project: PortableProject,
  options: unknown,
): string[] {
  // A zod-parsed project is frozen, so a mutation would throw a raw TypeError; a thawed deep copy
  // turns every mutation into the named violation below.
  const input = structuredClone(project);
  const first = compileForPlatform(target, input, options);
  const violations = [
    ...verdictViolations(target, project, first),
    ...dropRuleViolations(target, project, first),
  ];
  if (!first.ok) {
    violations.unshift(`${first.refusal.code}: ${first.refusal.message}`);
    return violations.map((violation) => `${label}: ${violation}`);
  }

  const second = compileForPlatform(target, structuredClone(project), options);
  if (!deepEqual(first, second)) violations.push('two compiles of one project differ (not pure)');
  if (!deepEqual(input, project)) violations.push('compile changed its input project');
  return violations.map((violation) => `${label}: ${violation}`);
}

function importViolations(
  target: PlatformTarget,
  project: PortableProject,
  options: unknown,
): string[] {
  if (target.import === undefined) return [];
  const compiled = compileForPlatform(target, structuredClone(project), options);
  if (!compiled.ok) return [];
  const imported = target.import(compiled.files);
  if (!imported.ok) return [`import refused its own output: ${imported.refusal.message}`];
  const root = project.agents.find((agent) => agent.name === project.root);
  const back = imported.project.agents.find((agent) => agent.name === imported.project.root);
  const violations: string[] = [];
  if (back?.name !== root?.name) violations.push('import changed the root agent name');
  if (back?.instructions !== root?.instructions) violations.push('import changed the instructions');
  return violations;
}

/**
 * Runs the platform conformance suite against `target` and throws one `Error` listing every
 * violation (its first line is the first reason). It compiles the shared sample, the sample
 * without a tool endpoint and the sample with engine and platform extensions, and checks the
 * verdict invariants, purity, the ADR-0133 D8 drop rules for hosted platforms and the import round
 * trip. P2-P8 call it from one test each. `options` is what every compile gets, for a target whose
 * options schema has required keys.
 */
export function runPlatformConformance(target: PlatformTarget, options: unknown = {}): void {
  const withEndpoint = parse(SAMPLE_PORTABLE_PROJECT);
  const violations = [
    ...conformanceViolations(target, 'sample', withEndpoint, options),
    ...conformanceViolations(
      target,
      'sample without endpoint',
      parse(SAMPLE_PORTABLE_PROJECT_WITHOUT_TOOL_ENDPOINT),
      options,
    ),
    ...conformanceViolations(
      target,
      'sample with extensions',
      parse(SAMPLE_PORTABLE_PROJECT_WITH_EXTENSIONS),
      options,
    ),
    ...importViolations(target, withEndpoint, options),
  ];
  if (violations.length > 0) {
    throw new Error(`${target.id} fails conformance:\n- ${violations.join('\n- ')}`);
  }
}
