import type {
  FieldVerdict,
  PlatformCapabilities,
  PlatformFile,
  PlatformId,
  PlatformRefusal,
} from '@indx-workspace/contracts/platforms';
import type { PortableProject } from '@indx-workspace/contracts/portable-agent';
import type { z } from 'zod';

export type PlatformCompileResult =
  | {
      readonly ok: true;
      readonly files: readonly PlatformFile[];
      readonly report: readonly FieldVerdict[];
    }
  | { readonly ok: false; readonly refusal: PlatformRefusal };

export type PlatformImportResult =
  | {
      readonly ok: true;
      readonly project: PortableProject;
      readonly report: readonly FieldVerdict[];
    }
  | { readonly ok: false; readonly refusal: PlatformRefusal };

/** One external agent host (ADR-0133 D7). Pure: no I/O, no clock, no randomness, no environment. */
export interface PlatformTarget<TOptions = unknown> {
  readonly id: PlatformId;
  readonly displayName: string;
  readonly docsUrl: string;
  readonly capabilities: PlatformCapabilities;
  /** Validates `extensions.platforms[id]` of the root agent, merged over project-file options (U1). */
  readonly optionsSchema: z.ZodType<TOptions>;
  compile(project: PortableProject, options: TOptions): PlatformCompileResult;
  import?(files: readonly PlatformFile[]): PlatformImportResult;
}
