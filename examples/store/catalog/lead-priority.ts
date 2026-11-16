import { defineEntry } from './define.ts';

export default defineEntry({
  slug: 'lead-priority',
  area: 'sales',
  status: 'soon',
  wave: 2,
  name: {
    ja: 'リード優先度づけ',
    en: 'Lead prioritizer',
  },
  summary: {
    ja: '問い合わせや展示会のリストを読み、先に連絡すべき相手を理由付きで並べる。',
    en: 'Reads enquiry and event lists and ranks who to call first, with reasons.',
  },
});
