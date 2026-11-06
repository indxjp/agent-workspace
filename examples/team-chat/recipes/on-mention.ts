import {
  blocksToMarkdown,
  defineRecipe,
  markdownToBlocks,
  resourceEvent,
  type RecipeClient,
  type RecordOf,
  type ResourceEventInput,
} from '@indx-workspace/app';

import helper from '../agents/helper.ts';
import message from '../resources/message.ts';

/** How many of the thread's latest messages the helper reads. */
const THREAD_WINDOW = 20;
const MENTION = new RegExp(`(?:^|\\s)@${helper.name}\\b`, 'u');
/** Every `@helper` in a text, wherever it stands, so a reply can be written without one. */
const ANY_MENTION = new RegExp(`@(${helper.name})\\b`, 'gu');

/**
 * The model's answer with each `@helper` written as a plain `helper`. The reply is a new message,
 * and a new message that mentions the helper starts this recipe again: the recipe tells its own
 * writes apart by never writing a mention (ADR-0164).
 */
function withoutMention(text: string): string {
  return text.replace(ANY_MENTION, '$1');
}

/** The helper's Agent Workspace id: AW_HELPER_AGENT_ID, else the workspace's agent of its name. */
async function helperId(aw: RecipeClient): Promise<string> {
  const configured = process.env['AW_HELPER_AGENT_ID'];
  if (configured !== undefined && configured !== '') return configured;
  const found = (await aw.agents.list()).find((agent) => agent.name === helper.name);
  if (found === undefined) throw new Error(`no agent named ${helper.name} in this workspace`);
  return found.id;
}

/**
 * On mention: a message that mentions `@helper` starts the helper for the person who wrote it,
 * with the thread's latest messages as the prompt, and posts its answer in that thread as the
 * person's agent, carrying the run's id (ADR-0164). The answer is posted with every `@helper`
 * written as plain `helper`, so the reply never starts the recipe again.
 *
 * shortcut: one new session per mention, not one per agent per channel; upgrade when a
 * session-per-channel lookup is needed.
 */
export default defineRecipe<ResourceEventInput>({
  name: 'on-mention',
  on: resourceEvent('message', 'created'),
  async run({ aw, input, step, store }) {
    const mention = input.record as unknown as RecordOf<typeof message.fields>;
    if (!MENTION.test(blocksToMarkdown(mention.body))) return;
    const root = mention.thread_root ?? mention.id;
    await step('reply', async () => {
      // shortcut: a list cannot filter on a ref() field yet, so the thread is read from the
      // newest 200 messages; upgrade when ResourceStore.list takes a ref() filter.
      const { items } = await store(message).list({ limit: 200 });
      const thread = items.filter((item) => item.id === root || item.thread_root === root);
      const prompt = thread
        .slice(0, THREAD_WINDOW)
        .reverse()
        .map((item) => blocksToMarkdown(item.body))
        .join('\n\n');
      const { result } = await aw.runs.start(await helperId(aw), { prompt });
      const text = withoutMention((await result).text ?? '');
      await store(message).create({
        channel: mention.channel,
        thread_root: root,
        body: markdownToBlocks(text),
      });
      return text;
    });
  },
});
