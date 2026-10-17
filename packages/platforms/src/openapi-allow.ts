import {
  selectAllowedOperations,
  type OpenApiOperationCandidate,
} from '@indx-workspace/contracts/tool-connectors';
import type { PortableProject } from '@indx-workspace/contracts/portable-agent';
import { parse } from 'yaml';

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

export type NarrowedOpenApiSpec =
  | { readonly ok: true; readonly spec: Record<string, unknown>; readonly operations: number }
  | { readonly ok: false; readonly reason: string };

interface Candidate extends OpenApiOperationCandidate {
  readonly operation: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function candidatesOf(paths: Record<string, unknown>): readonly Candidate[] {
  return Object.entries(paths).flatMap(([path, item]) => {
    if (!isRecord(item)) return [];
    return HTTP_METHODS.flatMap((method) => {
      const operation = item[method];
      if (!isRecord(operation)) return [];
      const operationId = operation['operationId'];
      return [
        {
          method,
          path,
          operation,
          ...(typeof operationId === 'string' ? { operationId } : {}),
        },
      ];
    });
  });
}

/**
 * The OpenAPI document of `tool` with only the operations its `allow` rules admit, read from the
 * bundled `project.openapiSpecs`. Pure. It fails, so the caller drops the tool, when the document is
 * not bundled or not an OpenAPI object, a rule is refused, or the rules admit nothing: exporting the
 * full document would grant more than the definition allows. Path-level keys stay on the paths that
 * keep an operation, except a `$ref`, which could reach operations the rules never saw;
 * `components` is not pruned.
 */
export function narrowOpenApiSpec(
  project: PortableProject,
  tool: { readonly specRef: string; readonly allow?: readonly string[] | undefined },
): NarrowedOpenApiSpec {
  if (tool.allow === undefined) return { ok: false, reason: 'the tool has no allow rules' };
  const bundled = project.openapiSpecs.find((spec) => spec.ref === tool.specRef);
  if (bundled === undefined) {
    return { ok: false, reason: 'the spec is not bundled, so allow cannot be applied' };
  }
  let document: unknown;
  try {
    document = parse(bundled.content);
  } catch {
    return { ok: false, reason: 'the bundled spec is not valid JSON or YAML' };
  }
  if (!isRecord(document) || !isRecord(document['paths'])) {
    return { ok: false, reason: 'the bundled spec has no paths object' };
  }
  const { admitted, refusals } = selectAllowedOperations(
    tool.allow,
    candidatesOf(document['paths']),
  );
  const [refusal] = refusals;
  if (refusal !== undefined) {
    return { ok: false, reason: `allow rule ${refusal.path[1]} is refused: ${refusal.message}` };
  }
  if (admitted.length === 0) return { ok: false, reason: 'allow admits no operation' };

  const paths: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(document['paths'])) {
    const kept = admitted.filter((candidate) => candidate.path === path);
    if (kept.length === 0 || !isRecord(item)) continue;
    const keptMethods = new Set<string>(kept.map((candidate) => candidate.method));
    paths[path] = Object.fromEntries(
      Object.entries(item).filter(
        ([key]) =>
          key !== '$ref' &&
          (!(HTTP_METHODS as readonly string[]).includes(key) || keptMethods.has(key)),
      ),
    );
  }
  return { ok: true, spec: { ...document, paths }, operations: admitted.length };
}
