import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'maintenance',
  area: 'mfg',
  status: 'live',
  wave: 1,
  kind: 'agent',
  source: 'tests/gallery/maintenance-troubleshooting',
  name: {
    ja: '保全トラブルシュート',
    en: 'Maintenance troubleshooting',
  },
  summary: {
    ja: 'ベテランのノウハウと設備マニュアルから、故障の切り分け手順を案内する。',
    en: "Guides fault isolation using veterans' know-how and equipment manuals.",
  },
  demo: {
    agent: 'maintenance-troubleshooting',
    prompts: [
      {
        ja: 'プレス2号機 油圧が上がらない。油面計は正常範囲。ポンプからガラガラ音がする',
        en: 'Press No. 2: hydraulic pressure will not build. The oil gauge is in range and the pump rattles.',
      },
      {
        ja: '溶接ロボット9号機 アークが出ない',
        en: 'Welding robot No. 9: no arc.',
      },
    ],
    moment: {
      ja: '若手が症状を伝えると、ベテランの記録をもとに「次に見る場所」を1つずつ案内する。',
      en: "A junior describes the symptom; the agent guides one check at a time from veterans' notes.",
    },
    data: {
      ja: '設備マニュアル2冊・トラブル記録4件・ベテランのメモ3本',
      en: '2 equipment manuals, 4 trouble records, 3 veteran notes',
    },
    seed: [
      { collection: 'trouble-log', from: 'data/trouble-log' },
      { collection: 'expert-notes', from: 'data/expert-notes' },
      { collection: 'manuals', from: 'data/manuals' },
    ],
    check: { tools: ['search_files'], approval: null },
  },
  safety: ['person'],
});
