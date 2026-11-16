/**
 * The code tool the tool-sandbox isolation lane runs (`tool-open` ships it, `tool-call` calls it).
 * The tool host imports a bundle whose default export is the run function; this one takes
 * `{ targets }` and makes, from inside the tool sandbox, the attempts the `probe` mode makes from a
 * sandbox-shaped job. It returns the raw attempts as JSON for `tool-call` to judge outside, and never
 * judges anything itself. The only import is the shared attempts module, which `tool-open` inlines
 * (the host imports a single file), so keep it free of other imports.
 */
import { collectAttempts, collectMetadata } from './attempts.mjs';

export default async function run({ targets }) {
  // The metadata token is fetched inside the tool sandbox and tried against the Cloud Run API and
  // testIamPermissions, alongside the network attempts. Without a project it is not tried at all, and
  // tool-call judges the token inconclusive.
  const [attempts, metadata] = await Promise.all([
    collectAttempts(targets),
    targets.project === undefined ? undefined : collectMetadata(targets.project, targets.region),
  ]);
  return JSON.stringify({ attempts, metadata });
}
