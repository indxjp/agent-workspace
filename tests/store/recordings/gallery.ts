/**
 * The gallery entries' recorders: each plays the entry's suggested prompt against the use case's
 * own scripted workspace (`tests/gallery/<use case>`), whose tools are the real servers, scripts
 * and fakes and whose model's decisions are scripted. A use case's fixture starts what it needs
 * in its own `beforeAll`, so importing it from the recordings test is enough.
 *
 * Every run starts with the entry's own suggested prompt, the one the recording shows. A use case's
 * scripted model is written for its fixture, so each recorder either reads the prompt (a request, a
 * spec, a question) or, where the model's decisions are fixed to one request, checks that the prompt
 * carries that request's identifiers and fails with the entry's name when it does not. A recording of
 * a question the agent was not asked would be a false one.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import * as cad from '../../gallery/cad-drafting/cad-drafting.fixture.test-support.ts';
import * as contract from '../../gallery/contract-review/contract-review.fixture.test-support.ts';
import { SERVICE_AGREEMENT } from '../../gallery/contract-review/data/drafts.ts';
import * as inquiry from '../../gallery/customer-inquiry/customer-inquiry.fixture.test-support.ts';
import * as excel from '../../gallery/excel-consolidation/excel-consolidation.fixture.test-support.ts';
import * as maintenance from '../../gallery/maintenance-troubleshooting/maintenance-troubleshooting.fixture.test-support.ts';
import * as manual from '../../gallery/manual-search/manual-search.fixture.test-support.ts';
import { readMeeting } from '../../gallery/meeting-minutes/backend/minutes.ts';
import * as minutes from '../../gallery/meeting-minutes/meeting-minutes.fixture.test-support.ts';
import * as defect from '../../gallery/quality-defect/quality-defect.fixture.test-support.ts';
import * as quotation from '../../gallery/quotation/quotation.fixture.test-support.ts';
import * as ringi from '../../gallery/ringi-review/ringi-review.fixture.test-support.ts';
import {
  scriptedWorkspace,
  type BuiltinTools,
  type Script,
  type ScriptContext,
} from '../../gallery/harness/scripted-workspace.ts';
import { GALLERY_WORKSPACE_ID } from '../../gallery/harness/identity.ts';
import { startFakeErp } from '../../gallery/quotation/erp/fake-erp.mjs';
import { playTurn } from './run.ts';
import type { Ask, Recorder } from './types.ts';

/** Fails with the entry's name unless the prompt carries every identifier the scripted model is fixed to. */
function carries(ask: Ask, ...needles: readonly string[]): void {
  const missing = needles.filter((needle) => !ask.prompt.includes(needle));
  if (missing.length > 0) {
    throw new Error(
      `${ask.slug} ${ask.lang}: the use case's scripted model does not handle this prompt (it lacks ${missing.join(', ')})`,
    );
  }
}

/** `model` with the first prompt of the turn read as `text`; an approval's continuation passes through. */
function reading<T>(
  model: (context: ScriptContext) => Promise<T>,
  prompt: string,
  text: string,
): (context: ScriptContext) => Promise<T> {
  return (context) => model(context.prompt === prompt ? { ...context, prompt: text } : context);
}

const QUOTE_SPEC = z.object({
  customer: z.string(),
  drawingNo: z.string(),
  partName: z.string(),
  material: z.enum(['SS400', 'SUS304', 'A5052']),
  lengthMm: z.number(),
  widthMm: z.number(),
  thicknessMm: z.number(),
  holeCount: z.number(),
  holeDiameterMm: z.number(),
  bendCount: z.number(),
  quantity: z.number(),
});

/** The part spec the request carries as a JSON block, as a model reads it. */
function specOf(ask: Ask): z.infer<typeof QUOTE_SPEC> {
  const block = /```json\n([\s\S]*?)\n```/u.exec(ask.prompt)?.[1];
  if (block === undefined)
    throw new Error(`${ask.slug} ${ask.lang}: the prompt carries no part spec`);
  return QUOTE_SPEC.parse(JSON.parse(block));
}

/** What a model searches the returns FAQ for, per question; the FAQ is Japanese. */
const FAQ_QUERIES: Readonly<Record<string, string>> = {
  '商品が届いてから何日以内なら返品できますか？': '返品 日以内',
};

/** The quotation fixture's connector id and identity key (its own constants, not exported). */
const ERP_CONNECTOR_ID = '6b1c1f0e-0000-4000-8000-000000000003';
const ERP_IDENTITY_KEY = 'gallery-erp-secret-0123456789';

/** `run_skill_script` as the platform runs it, as the quotation fixture does. */
const COST_MODEL: BuiltinTools = {
  run_skill_script: (args) => {
    const run = spawnSync(
      process.execPath,
      [quotation.ESTIMATE_SCRIPT, ...z.array(z.string()).parse(args['args'])],
      { encoding: 'utf8' },
    );
    return Promise.resolve({
      text: run.status === 0 ? run.stdout : run.stderr,
      isError: run.status !== 0,
    });
  },
};

const SKILL_CALL = z.object({
  skill: z.string(),
  script: z.string(),
  args: z.array(z.string()),
});
type SkillCall = z.infer<typeof SKILL_CALL>;

/**
 * `run_skill_script` as the platform runs it: the skill's script, run in the run's working
 * directory `cwd()` with the given arguments, no shell. `scripts` maps `<skill>/<script>` to the
 * script's file; any other script is refused, as a skill without it would be.
 */
function skillScripts(cwd: () => string, scripts: Readonly<Record<string, string>>): BuiltinTools {
  return {
    run_skill_script: (args) => {
      const call = SKILL_CALL.parse(args);
      const file = scripts[`${call.skill}/${call.script}`];
      if (file === undefined) {
        return Promise.resolve({ text: `no script ${call.skill}/${call.script}`, isError: true });
      }
      const run = spawnSync(process.execPath, [file, ...call.args], {
        cwd: cwd(),
        encoding: 'utf8',
      });
      return Promise.resolve({
        text: run.status === 0 ? run.stdout : run.stderr,
        isError: run.status !== 0,
      });
    },
  };
}

const isContinuation = (prompt: string): boolean => /^(approved|rejected)/u.test(prompt);

/**
 * `model` with the skill-script steps its use case runs in process made through `run_skill_script`,
 * where the agent's instructions place them: `beforeWrite` on the first turn just before its gated
 * `Write` (given that Write's input), `afterApproved` once the approved turn has made its `Write`
 * again (given the same input). The use case's scripted model computes the same thing in process,
 * which no trace shows; these calls run the skill's real script on the same inputs, so the recording
 * shows the real call and its real output.
 */
function scripting(
  model: Script,
  steps: {
    readonly beforeWrite?: (write: Record<string, unknown>) => Promise<readonly SkillCall[]>;
    readonly afterApproved?: (write: Record<string, unknown>) => Promise<readonly SkillCall[]>;
  },
): Script {
  return async (context) => {
    let written: Record<string, unknown> | null = null;
    const native: ScriptContext['native'] = async (name, input) => {
      if (name === 'Write' && written === null && !isContinuation(context.prompt)) {
        for (const call of (await steps.beforeWrite?.(input)) ?? []) {
          await context.builtin('run_skill_script', call);
        }
      }
      if (name === 'Write') written = input;
      return context.native(name, input);
    };
    const answer = await model({ ...context, native });
    if (context.prompt === 'approved' && written !== null) {
      for (const call of (await steps.afterApproved?.(written)) ?? []) {
        await context.builtin('run_skill_script', call);
      }
    }
    return answer;
  };
}

const WRITE = z.object({ file_path: z.string(), content: z.string() });

/**
 * The FAQ prose in a search snippet: the snippet is one line, so the file's front matter
 * (`--- title: … ---`) and a question's heading (`## Q1 <question> `) are cut out by their markers.
 */
const withoutFrontMatter = (snippet: string): string =>
  snippet
    .replace(/---.*?---/u, '')
    .replace(/#{1,6} Q\d+ \S+ /gu, '')
    .trim();

const HITS = z.array(z.object({ snippet: z.string() }));

export const GALLERY: Readonly<Record<string, Recorder>> = {
  'cad-drafting': (ask) => {
    carries(ask, 'BRK-1101', 'SUS304');
    // Once the change set is approved, `dxf.mjs draft` makes the drawing from the base the
    // office-reader read (`drafts/<base>.base.json`) and the approved change set, as step 5 says.
    const model = scripting(cad.designer(), {
      afterApproved: async (write) => {
        const { file_path: changes, content } = WRITE.parse(write);
        const { base, drawingNo } = z
          .object({ base: z.string(), drawingNo: z.string() })
          .parse(JSON.parse(content));
        const baseJson = `drafts/${base}.base.json`;
        await mkdir(path.join(cad.work, 'drafts'), { recursive: true });
        await mkdir(path.join(cad.work, 'outputs'), { recursive: true });
        await writeFile(path.join(cad.work, baseJson), JSON.stringify(await cad.drawingOf(base)));
        await writeFile(path.join(cad.work, changes), content);
        return [
          {
            skill: 'dxf-draft',
            script: 'dxf.mjs',
            args: ['draft', baseJson, changes, `outputs/${drawingNo}.dxf`],
          },
        ];
      },
    });
    const scripts = skillScripts(() => cad.work, {
      'dxf-draft/dxf.mjs': path.join(cad.DIR, 'skills', 'dxf-draft', 'scripts', 'dxf.mjs'),
    });
    return playTurn(cad.desk(model, scripts), ask.prompt, { subject: cad.DESIGNER });
  },

  'contract-review': (ask) => {
    carries(ask, 'ミナトシステムズ');
    // Before the redline's Write: office-reader reads the draft, the playbook checks it and
    // `clauses.mjs redline` makes the paragraphs the Write holds, as steps 1, 2 and 4 say.
    const file = contract.requestOf(SERVICE_AGREEMENT).file;
    const reviewer = contract.reviewer();
    const model: contract.DraftScript = (context, draft) =>
      scripting((inner) => reviewer(inner, draft), {
        beforeWrite: () => {
          const name = path.basename(draft, '.docx');
          const paragraphs = `drafts/${draft.split('/')[1] ?? ''}/${name}.json`;
          return Promise.resolve([
            { skill: 'office-reader', script: 'ooxml.mjs', args: ['docx', draft, paragraphs] },
            {
              skill: 'contract-playbook',
              script: 'clauses.mjs',
              args: ['check', paragraphs, '--playbook', 'playbook'],
            },
            {
              skill: 'contract-playbook',
              script: 'clauses.mjs',
              args: ['redline', paragraphs, '--playbook', 'playbook'],
            },
          ]);
        },
      })(context);
    const skills = (name: string, script: string) =>
      path.join(contract.sandbox, '.claude', 'skills', name, 'scripts', script);
    const scripts = skillScripts(() => contract.sandbox, {
      'office-reader/ooxml.mjs': skills('office-reader', 'ooxml.mjs'),
      'contract-playbook/clauses.mjs': skills('contract-playbook', 'clauses.mjs'),
    });
    return playTurn(contract.reviewWorkspace(model, scripts), ask.prompt, {
      subject: contract.SALES_MEMBER,
      attachments: [{ fileId: file.id }],
    });
  },

  'customer-inquiry': (ask) => {
    const query = FAQ_QUERIES[ask.ja];
    if (query === undefined) throw new Error(`${ask.slug}: no FAQ query for "${ask.ja}"`);
    // Search the FAQ, read the best hit, answer from it, as `agents/customer-inquiry.md` says.
    const model = async (context: ScriptContext) => {
      const found = HITS.parse(JSON.parse((await context.builtin('search_files', { query })).text));
      // The answer is the FAQ's own sentence that holds the query's words, not its front matter.
      const words = query.split(' ');
      const sentence = withoutFrontMatter(found[0]?.snippet ?? '')
        .split('。')
        .find((part) => words.every((word) => part.includes(word)));
      const best = sentence === undefined ? '' : `${sentence}。`;
      return inquiry.answer(`お問い合わせいただきありがとうございます。${best}`);
    };
    return playTurn(inquiry.workspaceFor(model), ask.prompt, { subject: 'C-1001' });
  },

  'excel-consolidation': (ask) => {
    carries(ask, '2025');
    // Before the plan's Write: one `consolidate.mjs inspect` over every workbook the plan reads, as
    // step 2 says.
    const model = scripting(excel.followInstructions(), {
      beforeWrite: (write) => {
        const plan = z
          .object({
            layouts: z.array(z.object({ files: z.array(z.string()) })),
            excluded: z.array(z.object({ file: z.string() })),
          })
          .parse(JSON.parse(WRITE.parse(write).content));
        const files = [
          ...new Set([
            ...plan.layouts.flatMap((layout) => layout.files),
            ...plan.excluded.map((entry) => entry.file).filter((file) => file.endsWith('.xlsx')),
          ]),
        ];
        return Promise.resolve([
          { skill: 'excel-consolidate', script: 'consolidate.mjs', args: ['inspect', ...files] },
        ]);
      },
    });
    const scripts = skillScripts(() => excel.work, {
      'excel-consolidate/consolidate.mjs': excel.CONSOLIDATE,
    });
    return playTurn(excel.workspaceFor(model, scripts), ask.prompt, { subject: excel.PLANNER });
  },

  maintenance: (ask) =>
    playTurn(
      maintenance.workspaceFor(reading(maintenance.pressDiagnosis, ask.prompt, ask.ja)),
      ask.prompt,
      { subject: maintenance.TECHNICIAN },
    ),

  'manual-search': (ask) =>
    playTurn(
      scriptedWorkspace(
        reading(manual.followInstructions, ask.prompt, ask.ja),
        {},
        { search_files: manual.search.call },
      ),
      ask.prompt,
      { subject: manual.ENGINEER },
    ),

  'meeting-minutes': async (ask) => {
    carries(ask, '2026-10-02');
    const transcript = await readFile(minutes.PRODUCTION, 'utf8');
    const meeting = readMeeting(transcript);
    const request = [
      `議事録の下書きを作成してください。会議日（相対日付の基準日）: ${meeting.date}`,
      `sourceMeeting: ${meeting.sourceMeeting}`,
      '--- 文字起こし ---',
      transcript,
    ].join('\n');
    const model = minutes.minutesModel();
    const workspace = scriptedWorkspace(
      async (context) => {
        // The agent opens the transcript the prompt names, then drafts from what it reads.
        await context.native('Read', { file_path: 'transcripts/2026-10-02_生産会議.txt' });
        return model({ ...context, prompt: request });
      },
      minutes.connectorsOf(await minutes.startTracker()),
    );
    return playTurn(workspace, ask.prompt, { subject: minutes.CLERK });
  },

  'quality-defect': (ask) =>
    playTurn(
      defect.qualityWorkspace(
        reading(defect.followInstructions(), ask.prompt, ask.ja.replaceAll('／', '\n')),
      ),
      ask.prompt,
      { subject: defect.QA_LEAD },
    ),

  quotation: async (ask) => {
    const records = ask.records;
    if (records === null) throw new Error(`${ask.slug} has no demo.records to record on`);
    const spec = specOf(ask);
    // The ERP serves the entry's own records, and lets the quote desk's salesperson see their customers.
    const data = await mkdtemp(path.join(tmpdir(), 'store-quotation-'));
    const erp = await (async () => {
      const language = path.join(records, ask.lang);
      for (const name of ['parts', 'orders', 'rates']) {
        await copyFile(path.join(language, `${name}.json`), path.join(data, `${name}.json`));
      }
      const parts = z
        .array(z.object({ customer: z.string() }))
        .parse(JSON.parse(await readFile(path.join(language, 'parts.json'), 'utf8')));
      const customers = [...new Set(parts.map((part) => part.customer))];
      await writeFile(
        path.join(data, 'access.json'),
        JSON.stringify({ [quotation.SALES_LEAD]: { customers } }),
      );
      return startFakeErp({
        token: quotation.ERP_TOKEN,
        identity: {
          key: ERP_IDENTITY_KEY,
          audience: ERP_CONNECTOR_ID,
          workspace: GALLERY_WORKSPACE_ID,
        },
        dataDir: data,
      });
    })();
    try {
      // The model reads the quantity the way the quote desk's own request states it.
      const model = reading(
        quotation.quotationModel(spec),
        ask.prompt,
        `顧客: ${spec.customer}\n数量: ${String(spec.quantity)}個`,
      );
      const workspace = scriptedWorkspace(
        model,
        {
          erp: {
            id: ERP_CONNECTOR_ID,
            session: quotation.erpGateway(erp.url, quotation.ERP_TOKEN),
            identityKey: ERP_IDENTITY_KEY,
          },
        },
        COST_MODEL,
      );
      return await playTurn(workspace, ask.prompt, {
        subject: quotation.SALES_LEAD,
        attachments: [{ fileId: quotation.DRAWING_ID }],
      });
    } finally {
      await erp.close();
      await rm(data, { recursive: true, force: true });
    }
  },

  'ringi-review': async (ask) => {
    // The model is fixed to the conveyor ringi: the prompt must describe that one (¥45M, one quote).
    carries(ask, ...(ask.lang === 'ja' ? ['4,500万円', '見積1社'] : ['¥45M', 'one quote']));
    const desk = await ringi.hook(
      reading(ringi.reviewer(), ask.prompt, `${ask.ja}\n${JSON.stringify(ringi.CONVEYOR)}`),
    );
    return playTurn(desk, ask.prompt, { subject: ringi.SUBMITTER });
  },
};
