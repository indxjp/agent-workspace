import type { RecordedRun } from '../proof/record-turn.ts';

export type Lang = 'ja' | 'en';

/** What a recorder is asked: one entry's first suggested prompt, in one language. */
export interface Ask {
  readonly slug: string;
  /** The entry's `demo.agent`: the agent the run is made as. */
  readonly agent: string;
  readonly lang: Lang;
  /** The entry's suggested prompt in `lang`: what the run is started with and the recording shows. */
  readonly prompt: string;
  /**
   * The same prompt in Japanese. The scripted model's decisions are written for the Japanese data
   * of a gallery use case, so it reads this where a real model would translate the question.
   */
  readonly ja: string;
  /** The entry's `demo.records` folder, absolute, with a `ja` and an `en` set; `null` when it has none. */
  readonly records: string | null;
  /**
   * The entry's `demo.outputSchema`, `null` when it declares none. `playTurn` starts the run with it,
   * as the Try it section does, so a charted entry's recording keeps its typed answer.
   */
  readonly outputSchema: Readonly<Record<string, unknown>> | null;
}

/** Plays one entry's moment and answers the runs it made, every approval approved. */
export type Recorder = (ask: Ask) => Promise<readonly RecordedRun[]>;
