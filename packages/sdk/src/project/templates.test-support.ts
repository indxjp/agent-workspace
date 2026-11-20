import { ProjectRenderError } from './errors.js';
import {
  parseFieldSpecs,
  refFieldsOf,
  renderAgentSpec,
  renderAppSpec,
  renderChannelSpec,
  renderGeneratorTemplate,
  renderPageSpec,
  renderRecipeSpec,
  renderResourceSpec,
  type GeneratorPageKind,
} from './generate.js';
import type { ProjectFile } from './template.js';

/** Each rendered file's path and the sha256 of its text, like the create output snapshot. */
export async function digests(files: readonly ProjectFile[]): Promise<Record<string, string>> {
  const entries = await Promise.all(
    files.map(async (file) => {
      const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(file.contents));
      const hex = [...new Uint8Array(bytes)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      return [file.path, hex] as const;
    }),
  );
  return Object.fromEntries(entries);
}

export const contentsOf = (files: readonly ProjectFile[], path: string): string | undefined =>
  files.find((file) => file.path === path)?.contents;

/** The import specifiers of every `import ... from '...';` line across the files. */
export const importSpecifiersOf = (files: readonly ProjectFile[]): string[] =>
  files.flatMap((file) =>
    [...file.contents.matchAll(/^import .* from '([^']+)';$/gmu)].map((match) => match[1] ?? ''),
  );

export const app = renderGeneratorTemplate('app', renderAppSpec('service-desk', ['ticket']));
const ticketValues = renderResourceSpec(
  'ticket',
  parseFieldSpecs([
    'title:text(200)',
    'description:richText',
    'estimate:number(0,100)?',
    'budget:money(JPY)',
    'urgent:bool',
    'due:date?',
    'opened_at:dateTime',
    'status:enum(new,in_progress,closed)',
    'assignee:person?',
    'parent:ref(ticket)?',
    'attachments:files',
    'labels:tags',
  ]),
  { board: 'status' },
);
export const resource = renderGeneratorTemplate('resource', ticketValues);
export const resourcePages = renderGeneratorTemplate('resource-pages', ticketValues);
export const workItemPages = renderGeneratorTemplate(
  'resource-pages',
  renderResourceSpec('work_item', parseFieldSpecs(['title:text'])),
);
const pageOf = (name: string, kind: GeneratorPageKind, resourceName?: string) => {
  const spec = renderPageSpec(name, { kind, resource: resourceName });
  return renderGeneratorTemplate(`page/${spec.kind}`, spec.values);
};
export const pages = {
  dashboard: pageOf('dashboard', 'dashboard'),
  list: pageOf('open-tickets', 'list', 'ticket'),
  custom: pageOf('team_rota', 'custom'),
};
export const agent = renderGeneratorTemplate(
  'agent',
  renderAgentSpec('triage', { appName: 'service-desk', resources: ['ticket'] }),
);

export const recipes = {
  resource: renderGeneratorTemplate(
    'recipe',
    renderRecipeSpec('enrich-contact', { on: 'resource:contact.created', resources: ['contact'] })
      .values,
  ),
  schedule: renderGeneratorTemplate(
    'recipe',
    renderRecipeSpec('sla-sweep', { on: 'schedule:*/5 * * * *', resources: [] }).values,
  ),
};

const messageValues = renderResourceSpec(
  'message',
  parseFieldSpecs([
    'thread_root:ref(message)?',
    'room:ref(room)',
    'body:richText',
    'attachments:files?',
  ]),
);
export const messageResource = renderGeneratorTemplate('resource', messageValues);
export const channel = renderGeneratorTemplate(
  'channel',
  renderChannelSpec('message', {
    refs: refFieldsOf(contentsOf(messageResource, 'resources/message.ts') ?? ''),
  }),
);

/** The `--key` refusal of `renderChannelSpec`, or `undefined` when it renders. */
export function channelRefusal(...args: Parameters<typeof renderChannelSpec>): string | undefined {
  try {
    renderChannelSpec(...args);
    return undefined;
  } catch (error) {
    if (!(error instanceof ProjectRenderError)) throw error;
    return error.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
  }
}
