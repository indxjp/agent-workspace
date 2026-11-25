/**
 * The recorders of the `use-cases/<slug>` entries of wave 2's parts (e) and (f), one module each in
 * `./use-cases/`: the document entries, whose deliverable `office-writer` renders behind the approval
 * (`./use-case-render.ts`), and the review entries whose report waits for it. As `./use-cases.ts`
 * says of every recorder, each plays the entry's first suggested prompt against the entry's own
 * agent, seeded files and skills, and checks that the prompt carries the request it is scripted for.
 */
import type { Recorder } from './types.ts';
import { announce } from './use-cases/announce.ts';
import { glossary } from './use-cases/glossary.ts';
import { interview } from './use-cases/interview.ts';
import { newcomer } from './use-cases/newcomer.ts';
import { privacy } from './use-cases/privacy.ts';
import { proposal } from './use-cases/proposal.ts';
import { releaseNotes } from './use-cases/release-notes.ts';
import { returns } from './use-cases/returns.ts';
import { translator } from './use-cases/translator.ts';
import { workInstruction } from './use-cases/work-instruction.ts';

export const USE_CASE_DOCUMENTS: Readonly<Record<string, Recorder>> = {
  announce,
  glossary,
  interview,
  newcomer,
  privacy,
  proposal,
  'release-notes': releaseNotes,
  returns,
  translator,
  'work-instruction': workInstruction,
};
