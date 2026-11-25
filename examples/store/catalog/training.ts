import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'training',
  area: 'hr',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/training',
  name: {
    ja: '研修計画',
    en: 'Training planner',
  },
  summary: {
    ja: 'スキルマップと役割の目標、研修カタログ、1on1のメモから、一人分の研修計画案を作る。人の評価や順位付けはしない。',
    en: "Drafts one person's training plan from the skills matrix, the role targets, the training catalog and the one-on-one notes. It never rates or ranks anyone.",
  },
  demo: {
    agent: 'training',
    prompts: [
      {
        ja: '小雀ちひろさんの 1on1 メモから、2027年上期の研修計画案を作成して',
        en: "Draft Chihiro Kogara's 2027 H1 training plan from the one-on-one notes",
      },
      {
        ja: '小雀ちひろさんの研修計画案の構成だけを示して',
        en: "Show only the outline of Chihiro Kogara's training plan",
      },
    ],
    moment: {
      ja: '1on1 のメモを渡すと、目標に届いていないスキルと合う研修の構成が出典付きで出て、Word の書き出しが承認待ちになる。人の評価や順位は出さない。',
      en: 'Hand over the one-on-one notes; out comes an outline of the skills below target and the courses that fit, each with its source, with no rating or rank, and the Word document waits for approval.',
    },
    data: {
      ja: '架空のスキルマップ・役割ごとの目標レベル・研修カタログ・1on1 のメモ',
      en: 'a fictional skills matrix, role target levels, a training catalog and one-on-one notes',
    },
    seed: [{ collection: 'training', from: 'data' }],
    check: { tools: ['search_files'], approval: 'run_skill_script' },
  },
  safety: ['person', 'approval', 'files', 'structured'],
});
