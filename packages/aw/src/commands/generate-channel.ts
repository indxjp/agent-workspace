/**
 * `aw generate channel <resource> [--key <refField>]` (issue #1519): binds a resource to a
 * realtime `channel()` of the app kit. It writes exactly
 *
 * - `channels/<resource>.ts`, the channel, keyed on the resource's `ref()` field (`--key`, or
 *   the first `ref()` to another resource);
 * - `app/api/channels/<resource>/events/route.ts`, its event stream;
 * - `app/channels/<resource>/[key]/page.tsx`, the channel screen (`ChannelView`);
 *
 * and edits each of the resource's two generated route files by one line, passing
 * `{ publish: <channel> }` (and importing it), so every write of the resource, through a route or
 * an agent tool, publishes on the channel. It is all recorded in `aw-generated.json`, so
 * `aw destroy channel <resource>` removes exactly that and refuses a file edited since.
 *
 * The key is read from `resources/<resource>.ts`: a resource without a `ref()` field to key on
 * is refused with `channel_key_required` before anything is written.
 */
import {
  channelRouteEdits,
  refFieldsOf,
  renderChannelSpec,
  renderGeneratorTemplate,
  type GeneratedEdit,
} from '@indx-workspace/sdk/project';

import type { LocalCommandContext } from '../command.js';
import { withReplacedLine } from '../generate/edits.js';
import {
  carryOut,
  cwdOf,
  generatedApp,
  onlyName,
  refuseRecorded,
  refuseTaken,
  rendered,
  type Generation,
  type InPlaceEdit,
} from '../generate/generation.js';
import { readManifest } from '../generate/manifest.js';
import { readTextIfPresent } from '../generate/write.js';
import { CommandRefusedError } from '../io.js';

const WHAT = 'aw generate channel';

/** The route files' in-place edits and their records, refused when a file is not as generated. */
async function routeEdits(
  cwd: string,
  name: string,
): Promise<{ readonly inPlace: readonly InPlaceEdit[]; readonly edits: readonly GeneratedEdit[] }> {
  const inPlace: InPlaceEdit[] = [];
  const edits: GeneratedEdit[] = [];
  for (const edit of channelRouteEdits(name)) {
    const text = await readTextIfPresent(cwd, edit.path);
    const next = text === undefined ? undefined : withReplacedLine(text, edit);
    if (next === undefined) {
      throw new CommandRefusedError(
        `${edit.path} is missing, already imports the channel, or has no line ${edit.replaced}`,
        `pass { publish: <channel> } to the route in ${edit.path} by hand`,
      );
    }
    inPlace.push({ path: edit.path, text: next });
    edits.push(
      { path: edit.path, added: edit.import },
      { path: edit.path, added: edit.added, replaced: edit.replaced },
    );
  }
  return { inPlace, edits };
}

export async function runGenerateChannel(context: LocalCommandContext): Promise<void> {
  const cwd = cwdOf(context, WHAT);
  const name = onlyName(context, WHAT);
  const key = context.args.values.get('key');
  const manifest = await readManifest(cwd);
  await generatedApp(cwd, manifest);
  refuseRecorded(manifest, 'channel', name);
  const source = await readTextIfPresent(cwd, `resources/${name}.ts`);
  if (source === undefined) {
    throw new CommandRefusedError(
      `there is no resource ${name} here (no resources/${name}.ts)`,
      `aw generate resource ${name} <field:type>... first`,
    );
  }
  const values = rendered(() => renderChannelSpec(name, { key, refs: refFieldsOf(source) }));
  const { inPlace, edits } = await routeEdits(cwd, name);
  const generation: Generation = {
    kind: 'channel',
    name,
    files: renderGeneratorTemplate('channel', values),
    inPlace,
    edits,
  };
  await refuseTaken(cwd, generation);
  await carryOut(context, cwd, manifest, generation);
}
