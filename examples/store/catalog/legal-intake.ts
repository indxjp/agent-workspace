import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'legal-intake',
  area: 'legal',
  status: 'soon',
  wave: 3,
  kind: 'agent',
  source: 'use-cases/legal-intake',
  name: {
    ja: '法務相談受付',
    en: 'Legal intake',
  },
  summary: {
    ja: '社内からの相談を分類し、必要な資料をそろえて法務に渡す。',
    en: 'Sorts internal legal requests and hands them over with the right documents.',
  },
  demo: {
    agent: 'legal-intake',
    prompts: [
      {
        ja: '法務相談 LGL-0101 を受け付けて、担当者に渡してください',
        en: 'Take in legal request LGL-0101 and hand it to a lawyer',
      },
      {
        ja: '法務相談 LGL-0102 を受け付けて、足りない資料も挙げてください',
        en: 'Take in legal request LGL-0102 and list the missing documents',
      },
    ],
    moment: {
      ja: '相談を渡すと、分類と急ぎかどうか、そろっている資料と足りない資料が決まり、担当者へのタスクの登録は承認を待つ。',
      en: 'Hand over a request; it sets the category and urgency and lists the documents present and missing, and the task for the lawyer waits for approval.',
    },
    data: {
      ja: '架空の法務相談フォームの相談・契約台帳・法務部の担当表',
      en: 'Fictional legal request forms, the contract register and the legal team list',
    },
    seed: [{ collection: 'legal-intake', from: 'data/ja' }],
    check: { tools: ['search_files'], approval: 'create_task' },
  },
  safety: ['person', 'approval', 'trigger', 'structured', 'files'],
});
