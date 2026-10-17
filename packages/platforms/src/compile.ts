import type { PlatformRefusal } from '@indx-workspace/contracts/platforms';
import type { PortableProject } from '@indx-workspace/contracts/portable-agent';

import { portableFieldPaths } from './paths.js';
import type { PlatformCompileResult, PlatformTarget } from './port.js';

const REFUSAL_DETAILS_MAX = 64;
const REFUSAL_DETAIL_MAX_LENGTH = 1_024;

function refuse(
  code: PlatformRefusal['code'],
  message: string,
  details: readonly string[],
): PlatformCompileResult {
  return {
    ok: false,
    refusal: {
      code,
      message,
      details: details
        .slice(0, REFUSAL_DETAILS_MAX)
        .map((detail) => detail.slice(0, REFUSAL_DETAIL_MAX_LENGTH)),
    },
  };
}

/** Orders by UTF-16 code unit, which is stable across locales and runtimes. */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * The one entry point callers use (U2, U5): checks the root, validates options, compiles, and orders
 * the report by {@link portableFieldPaths} order. Never throws for an expected failure.
 */
export function compileForPlatform<TOptions>(
  target: PlatformTarget<TOptions>,
  project: PortableProject,
  rawOptions: unknown,
): PlatformCompileResult {
  if (!project.agents.some((agent) => agent.name === project.root)) {
    return refuse(
      'platform_agent_not_found',
      `The root agent ${project.root} is not in the project.`,
      [project.root],
    );
  }

  const parsed = target.optionsSchema.safeParse(rawOptions ?? {});
  if (!parsed.success) {
    return refuse(
      'platform_options_invalid',
      `The options for ${target.id} are invalid.`,
      parsed.error.issues.map(
        (issue) => `${issue.path.map(String).join('.') || '(options)'}: ${issue.message}`,
      ),
    );
  }

  const result = target.compile(project, parsed.data);
  if (!result.ok) return result;

  const order = new Map(
    portableFieldPaths(project, { withGeneratedDescriptions: true }).map((path, index) => [
      path,
      index,
    ]),
  );
  return {
    ok: true,
    files: [...result.files].sort((a, b) => byCodeUnit(a.path, b.path)),
    report: [...result.report].sort((a, b) => {
      const left = order.get(a.path);
      const right = order.get(b.path);
      if (left !== undefined && right !== undefined) return left - right;
      if (left !== undefined) return -1;
      if (right !== undefined) return 1;
      return byCodeUnit(a.path, b.path);
    }),
  };
}
