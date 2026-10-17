/**
 * Which discovered models an agent's engine can drive (issue #393) — the composer's model picker
 * offers only these.
 *
 * A provider's model list is everything its account can call, and much of it cannot run an agent
 * loop at all: OpenAI's `/v1/models` lists embedding, speech, image and moderation models beside
 * the chat models, and Anthropic's lists retired generations. Picking one of those produced a run
 * that failed at its first model call, which read like a broken key. No engine publishes per-model
 * capability metadata (`EngineCapabilities` describes the engine, not the model), so this is a
 * deliberately conservative allow rule, applied in two steps:
 *
 * 1. **Provider.** The connection's provider must be one the engine can reach: its wire protocols
 *    and the gateway's protocols for that provider must overlap (`server/engines/protocol.ts`). The
 *    server computes that list per agent and hands it to the composer as `drivableProviders`.
 * 2. **Model id.** A model must be one that holds a tool-using conversation:
 *    - `anthropic`: an id starting `claude-`, except the retired `claude-instant`, `claude-2` and
 *      `claude-3-*` generations other than `claude-3-7-*`;
 *    - every other provider: any id that is not a known non-chat family (embeddings, speech,
 *      transcription, image, video, moderation, realtime, search, completion-only `davinci`/`babbage`).
 *      `anthropic-compatible`, `azure-openai` and `openai-compatible` ids are deployment or proxy
 *      names the platform cannot interpret, so only that deny-list applies to them.
 *
 * A model this rule hides can still be chosen as an agent's own default on the agent form; the
 * rule narrows the composer's per-run override, it does not forbid a model.
 */
import type { CatalogModel } from './catalog';

const RETIRED_CLAUDE = /^claude-(?:instant|2|3-(?!7-))/u;
/**
 * The non-chat families, each matched as whole tokens of the id (separated by `-`, `_`, `.`, `/` or
 * `:`), so a deployment name that merely contains one — `research-gpt4o` holds `search` — is not
 * mistaken for it. A token may also end at `@`, Vertex AI's version separator
 * (`imagegeneration@006`).
 *
 * The embedding family is wider than one word: providers fuse it with a prefix or a suffix
 * (`textembedding-gecko`, `embeddinggemma`, `snowflake-arctic-embed2`), so a token that starts with
 * `embedding`, or is `embed`/`embeds`/`embedding(s)` with an optional `text` prefix and version
 * digits, is one. Google's image (`imagen`, `imagegeneration`), video (`veo`) and speech
 * (`chirp`) families are listed beside OpenAI's.
 */
const NON_CHAT_MODEL =
  /(?:^|[-_./:])(?:(?:text)?embed(?:ding)?s?\d*|embedding\w*|tts|whisper|chirp|dall-e|davinci|babbage|moderation|image|imagen|imagegeneration|veo|audio|realtime|transcribe|search)(?:$|[-_./:@])/u;

/** Whether one provider-side model id passes step 2 of the module's rule. */
export function isAgentCapableModel(provider: string, providerModelId: string): boolean {
  const id = providerModelId.toLowerCase();
  if (NON_CHAT_MODEL.test(id)) return false;
  if (provider === 'anthropic') return id.startsWith('claude-') && !RETIRED_CLAUDE.test(id);
  return true;
}

/** The catalogue rows an engine that reaches `drivableProviders` can drive. */
export function modelsDrivableBy(
  drivableProviders: readonly string[],
  models: readonly CatalogModel[],
): readonly CatalogModel[] {
  const reachable = new Set(drivableProviders);
  return models.filter(
    (model) =>
      reachable.has(model.provider) && isAgentCapableModel(model.provider, model.providerModelId),
  );
}
