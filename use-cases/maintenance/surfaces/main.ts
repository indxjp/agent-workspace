import { defineSurface } from '@indx-workspace/sdk/define';

export default defineSurface({
  name: 'main',
  agent: 'maintenance',
  title: '設備トラブル対応',
  layout: 'side',
  parts: {
    greeting:
      '設備番号と症状を教えてください。過去トラとベテランのメモから、次に見る場所を1つずつ案内します。Tell me the machine and the symptom: I guide one check at a time from the trouble log and the veterans’ notes.',
    suggestedPrompts: [
      'プレス2号機 油圧が上がらない。油面計は正常範囲。ポンプからガラガラ音がする',
      'Press No. 2: hydraulic pressure will not build. The oil gauge is in range and the pump rattles.',
      '溶接ロボット9号機 アークが出ない',
      'Welding robot No. 9: no arc.',
    ],
    disclaimer:
      '案内は記録とマニュアルだけに基づきます。作業は必ず安全措置のあとで。Guidance comes only from the records and manuals; always make the machine safe first.',
    toolTrace: 'collapsed',
    feedback: true,
  },
  // Search hits render as cards. The key is the tool's bare name: a run's engine prefix is ignored.
  toolResults: { search_files: 'card' },
});
