/**
 * The exhaustiveness arm of an outcome `switch`: reaching it means the directory returned an
 * outcome this handler does not know, and refusing loudly beats answering as if it did.
 */
export function unhandledOutcome(handler: string, outcome: never): never {
  throw new Error(`unhandled ${handler} outcome ${JSON.stringify(outcome)}`);
}
