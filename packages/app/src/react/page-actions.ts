/**
 * The page view's agent actions (issue #1521), pure: the prompts "Rewrite with <agent>" and
 * "Summarize into new page" pre-fill the agent panel with. Each names the page by id, the tool to
 * write with, and for a rewrite the `expectedRevisionId` to pass, so the agent's change lands as
 * a new revision of the page the person was looking at, and never over a newer edit.
 *
 * The panel's route prefixes every prompt with the record it is about (`page <id>: `), and the
 * agent acts as the person: its write carries its run, and is refused what the person may not do.
 */
import type { AppLocale } from './locale.js';

/** What a prompt says of the page: its id and title. */
export interface PromptPage {
  readonly id: string;
  readonly title: string;
}

/** What a prompt may be told: the page resource's name (`page`), which its tools are named by. */
export interface PromptOptions {
  readonly name?: string;
  readonly locale?: AppLocale;
}

function toolsOf(options: PromptOptions): {
  readonly get: string;
  readonly update: string;
  readonly create: string;
} {
  const name = options.name ?? 'page';
  return { get: `${name}_get`, update: `${name}_update`, create: `${name}_create` };
}

/** A title as a prompt quotes it: on one line, its quotes as JSON writes them. */
function quoted(title: string): string {
  return JSON.stringify(title.replace(/\s+/gu, ' ').trim());
}

/**
 * The prompt of "Rewrite with <agent>": read the page, then save a clearer body with
 * `<name>_update`, passing `revisionId` as `expectedRevisionId`.
 */
export function rewritePrompt(
  page: PromptPage,
  revisionId: string,
  options: PromptOptions = {},
): string {
  const tools = toolsOf(options);
  const update = JSON.stringify({ id: page.id, markdown: '…', expectedRevisionId: revisionId });
  const get = JSON.stringify({ id: page.id });
  if (options.locale === 'ja') {
    return [
      `ページ ${quoted(page.title)}（id ${page.id}）を、内容の事実を変えずに読みやすく書き換えてください。`,
      `1. ${tools.get} ${get} で読みます。`,
      `2. 新しい本文を ${tools.update} ${update} で保存します。expectedRevisionId は ${revisionId} のままにしてください。`,
      '変更は新しいリビジョンとして残ります。page_conflict が返ったら、その後に誰かが保存しています。読み直してからやり直してください。',
    ].join('\n');
  }
  return [
    `Rewrite the page ${quoted(page.title)} (id ${page.id}) so it reads clearly, keeping its facts.`,
    `1. Read it with ${tools.get} ${get}.`,
    `2. Save the new body with ${tools.update} ${update}, keeping expectedRevisionId ${revisionId}.`,
    'The change lands as a new revision. If it is refused page_conflict, someone saved since: read it again and start over.',
  ].join('\n');
}

/**
 * The prompt of "Summarize into new page": read the page and the pages under it, then create one
 * new page under it with `<name>_create`.
 */
export function summarizePrompt(
  page: PromptPage,
  childIds: readonly string[],
  options: PromptOptions = {},
): string {
  const tools = toolsOf(options);
  const ids = [page.id, ...childIds].join(', ');
  const create = JSON.stringify({ parent: page.id, title: '…', markdown: '…' });
  if (options.locale === 'ja') {
    return [
      `ページ ${quoted(page.title)}（id ${page.id}）とその下のページを要約して、新しいページにまとめてください。`,
      `1. ${tools.get} で次のページを読みます：${ids}。`,
      `2. 要約を ${tools.create} ${create} で、このページの下に新しいページとして作成します。`,
      '既存のページは変更しないでください。',
    ].join('\n');
  }
  return [
    `Summarize the page ${quoted(page.title)} (id ${page.id}) and the pages under it into one new page.`,
    `1. Read each of them with ${tools.get}: ${ids}.`,
    `2. Create the summary under it with ${tools.create} ${create}.`,
    'Do not change the pages you read.',
  ].join('\n');
}
