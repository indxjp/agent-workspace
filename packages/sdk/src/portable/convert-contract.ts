import {
  type ProjectConnector,
  type ProjectModelConnection,
} from '@indx-workspace/contracts/project-file';

import { type ToolDefinition } from '../define/version-body.js';

/** One thing a conversion could not carry, at the input's dotted path, with the reason a person acts on. */
export interface PortableDrop {
  readonly path: string;
  readonly reason: string;
}

/** A conversion's answer: the value, and everything it left out. Never silent (ADR-0133 D5). */
export interface PortableConversion<T> {
  readonly value: T;
  readonly dropped: readonly PortableDrop[];
}

/** A code tool's declaration as a version pins it or `defineTool()` makes it. */
export interface PortableCodeToolDeclaration {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  /** Not carried by `PortableTool`; reported in `dropped` when present. */
  readonly outputSchema?: Readonly<Record<string, unknown>> | undefined;
  /** Not carried; reported only when it differs from {@link CODE_TOOL_DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number | undefined;
  /** Secret names, never values. Not carried; reported in `dropped` when present. */
  readonly secrets?: readonly string[] | undefined;
  /** An egress restriction. Not carried; always reported in `dropped` when present. */
  readonly allowedDomains?: readonly string[] | undefined;
}

/** What resolves the names a version body holds. Every field is optional; an unresolved name is dropped, never guessed. */
export interface PortableAgentContext {
  /** agent-workspace.yaml `connectors:`, by name. */
  readonly connectors?: Readonly<Record<string, ProjectConnector>> | undefined;
  /** agent-workspace.yaml `models:`, by connection name. */
  readonly models?: Readonly<Record<string, ProjectModelConnection>> | undefined;
  /** The catalog tools of the project or workspace, by name. */
  readonly catalogTools?: readonly ToolDefinition[] | undefined;
  /** Code tool declarations; when absent, the body's own `toolBundles` declarations are used. */
  readonly codeTools?: readonly PortableCodeToolDeclaration[] | undefined;
}

export function own<T>(
  record: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

export function finish<T>(value: T, drops: readonly PortableDrop[]): PortableConversion<T> {
  return Object.freeze({
    value,
    dropped: Object.freeze(drops.map((drop) => Object.freeze({ ...drop }))),
  });
}
