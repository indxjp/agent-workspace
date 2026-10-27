import { ShareTranscriptSelectionSchema } from '@indx-workspace/contracts/shares';
import { z } from 'zod';
import { DomainError } from '../../errors';

const AgentDefinitionInputSchema = z
  .object({
    name: z.string().min(1),
    instructions: z.string(),
    modelConnectionName: z.string().min(1).optional(),
    connectorNames: z.array(z.string().min(1)).optional(),
    fileCount: z.number().int().nonnegative().safe().optional(),
  })
  .catchall(z.unknown())
  .transform(({ modelConnectionName, connectorNames, fileCount, ...definition }) => ({
    ...definition,
    ...(modelConnectionName === undefined ? {} : { modelConnectionName }),
    ...(connectorNames === undefined ? {} : { connectorNames }),
    ...(fileCount === undefined ? {} : { fileCount }),
  }));

/** The complete, strict request contract for publishing a share. */
export const PublishShareRequestSchema = z
  .object({
    subjectType: z.enum(['agent', 'session', 'project', 'skill']),
    subjectId: z.string().min(1),
    subjectLabel: z.string().min(1),
    visibility: z.enum(['private', 'workspace', 'public']),
    mode: z.enum(['definition', 'runnable']).optional(),
    snapshot: z.unknown().optional(),
    include: z
      .object({
        technicalDetails: z.boolean().optional(),
        outputFiles: z.boolean().optional(),
      })
      .strict()
      .transform(({ technicalDetails, outputFiles }) => ({
        ...(technicalDetails === undefined ? {} : { technicalDetails }),
        ...(outputFiles === undefined ? {} : { outputFiles }),
      }))
      .optional(),
    expiry: z.enum(['24 h', '7 days', '30 days', 'never']).optional(),
    passphrase: z.string().min(1).max(1_024).optional(),
    budgetCapUsd: z.number().positive().finite().optional(),
    /** Run ids of the shared session; the server copies their text (ADR-0158). */
    transcript: ShareTranscriptSelectionSchema.optional(),
    definition: AgentDefinitionInputSchema.optional(),
  })
  .strict()
  .superRefine((request, context) => {
    const reject = (field: string, message: string) =>
      context.addIssue({ code: 'custom', path: [field], message });
    if (request.subjectType !== 'agent') {
      if (request.mode !== undefined) reject('mode', 'mode is supported only for agent shares');
      if (request.definition !== undefined)
        reject('definition', 'definition is supported only for agent shares');
      if (request.budgetCapUsd !== undefined)
        reject('budgetCapUsd', 'budgetCapUsd is supported only for runnable agent shares');
    } else if (request.budgetCapUsd !== undefined && request.mode !== 'runnable') {
      reject('budgetCapUsd', 'budgetCapUsd requires runnable mode');
    }
    if (request.subjectType !== 'session') {
      if (request.transcript !== undefined)
        reject('transcript', 'transcript is supported only for session shares');
      if (request.include !== undefined)
        reject('include', 'include is supported only for session shares');
    }
  });

export type PublishShareRequest = z.infer<typeof PublishShareRequestSchema>;
export type PublishShareInput = Omit<PublishShareRequest, 'transcript' | 'definition'>;

export function parsePublishShareRequest(value: unknown): PublishShareRequest {
  const result = PublishShareRequestSchema.safeParse(value);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
      .join('; ');
    throw new DomainError({
      category: 'validation',
      code: 'invalid_share',
      publicMessage: detail,
    });
  }
  return result.data;
}
