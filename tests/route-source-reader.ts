import { HTTP_METHODS } from './inventory-support.js';
import type { HttpMethod } from './inventory-support.js';
import { type RouteFile } from './route-files.js';

interface ExportedBinding {
  /** The identifier the statement binds — `GET`, `runtime`. */
  readonly name: string;
  /** Everything after the `export` keyword, trimmed: `const runtime = 'nodejs';` */
  readonly declaration: string;
}

function exportedBindings(source: string, file: string): ExportedBinding[] {
  const out: ExportedBinding[] = [];
  for (const match of source.matchAll(/^[ \t]*export\b[ \t]*(.*)$/gm)) {
    const declaration = (match[1] ?? '').trim();
    if (/^(?:type|interface|enum)\b/.test(declaration)) continue;
    const value =
      /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/.exec(declaration) ??
      /^class\s+([A-Za-z_$][\w$]*)/.exec(declaration) ??
      /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/.exec(declaration);
    if (value === null) {
      throw new Error(
        `${file}: "export ${declaration}" is an export form the route inventory cannot decode. It ` +
          `reads source text, so it cannot tell what that binds, and a form it cannot read would ` +
          `become a route nothing sees. Write each export as "export async function NAME(…)", ` +
          `"export const NAME = …", or a type.`,
      );
    }
    out.push({ name: value[1] as string, declaration });
  }
  return out;
}

export function exportedMethods(source: string, file: string): ReadonlySet<HttpMethod> {
  if (/^\s*export\s*\{/m.test(source)) {
    throw new Error(
      `${file}: this route file re-exports its handlers with "export { … }". The route inventory ` +
        `reads source text and cannot follow that, so it would under-report the route's methods. ` +
        `Declare each handler with "export async function GET(…)" instead.`,
    );
  }
  const methods = new Set<string>(HTTP_METHODS);
  const found = new Set<HttpMethod>();
  for (const binding of exportedBindings(source, file)) {
    if (methods.has(binding.name)) found.add(binding.name as HttpMethod);
  }
  if (found.size === 0) {
    throw new Error(
      `${file}: a route file that exports no HTTP method serves nothing. Delete it or export one.`,
    );
  }
  return found;
}

export function exportedStringConstant(source: string, name: string, file: string): string | null {
  const binding = exportedBindings(source, file).find((entry) => entry.name === name);
  if (binding === undefined) return null;
  const literal = new RegExp(`^(?:const|let|var)\\s+${name}\\s*=\\s*(['"])(.*)\\1;?$`).exec(
    binding.declaration,
  );
  if (literal === null) {
    throw new Error(
      `${file}: exports "${name}" as "${binding.declaration}", a value this gate cannot evaluate — ` +
        `it reads source text. Next.js reads this export as a constant, so write it as one.`,
    );
  }
  return literal[2] as string;
}

export function streamOffenders(files: readonly RouteFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    file.source.split('\n').forEach((line, index) => {
      if (!/\bReadableStream\b/.test(line)) return;
      if (/^\s*(?:\/\/|\*|\/\*)/.test(line)) return;
      offenders.push(`${file.repoPath}:${index + 1}`);
    });
  }
  return offenders;
}
