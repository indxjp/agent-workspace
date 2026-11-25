import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'meeting-minutes',
  area: 'collab',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'tests/gallery/meeting-minutes',
  name: {
    ja: '議事録・ToDo抽出',
    en: 'Meeting minutes',
  },
  summary: {
    ja: '文字起こしから議事録と、担当・期限付きのToDoを作る。',
    en: 'Turns a transcript into minutes and to-dos with owners and dates.',
  },
  demo: {
    agent: 'meeting-minutes',
    prompts: [
      {
        ja: 'transcripts/2026-10-02_生産会議.txt の文字起こしから議事録の下書きを作成してください。会議日（相対日付の基準日）: 2026-10-02',
        en: 'Draft the minutes from the transcript in transcripts/2026-10-02_生産会議.txt. Meeting date (base for relative dates): 2026-10-02',
      },
      {
        ja: 'transcripts/2026-10-05_新製品開発定例.vtt から議事録の下書きを作成してください。会議日（相対日付の基準日）: 2026-10-05',
        en: 'Draft the minutes from transcripts/2026-10-05_新製品開発定例.vtt. Meeting date (base for relative dates): 2026-10-05',
      },
    ],
    moment: {
      ja: '文字起こしを渡すと、議事録と「誰が・いつまでに」のToDoが表になる。',
      en: 'Hand over a transcript; get minutes and a to-do table with who and by when.',
    },
    data: {
      ja: '会議の文字起こし2本',
      en: '2 meeting transcripts',
    },
    seed: [{ collection: 'transcripts', from: 'data/transcripts' }],
    check: { tools: ['Read', 'list_members'], approval: null },
  },
  safety: ['person', 'files', 'structured'],
  next: {
    source: 'use-cases/meeting-minutes',
    demo: {
      agent: 'meeting-minutes',
      prompts: [
        {
          ja: '2026-10-02_生産会議.txt の文字起こしから議事録を作成して保存してください。会議日（相対日付の基準日）: 2026-10-02',
          en: 'Write the minutes from 2026-10-02_production-meeting.txt and save them. Meeting date (base for relative dates): 2026-10-02',
        },
        {
          ja: '2026-10-05_新製品開発定例.vtt から議事録を作成して保存してください。会議日（相対日付の基準日）: 2026-10-05',
          en: 'Write the minutes from 2026-10-05_new-product-review.vtt and save them. Meeting date (base for relative dates): 2026-10-05',
        },
      ],
      moment: {
        ja: '文字起こしを渡すと、議事録と「誰が・いつまでに」のToDoが表になり、保存は承認を待つ。',
        en: 'Hand over a transcript; get minutes and a to-do table with who and by when, saved once a person approves.',
      },
      data: {
        ja: '架空の会議の文字起こし2本と社内メンバー一覧',
        en: '2 fictional meeting transcripts and the member list',
      },
      seed: [{ collection: 'meeting-minutes', from: 'data' }],
      check: { tools: ['search_files'], approval: 'run_skill_script' },
    },
  },
});
