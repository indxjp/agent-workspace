/**
 * Three counterparty drafts, as their paragraphs. The test writes each to a real .docx with the
 * shared office-reader writer, so the review reads Word files without a binary in the repository.
 *
 * 当社 is the party the playbook protects. Each draft plants issues the way counterparties write
 * them, and keeps other clauses at the playbook's standard wording, so a test can check both that
 * every planted issue is found and that a standard clause is left alone. The drafts also vary
 * what a real tree of Word files varies: headings styled or typed as body text, full-width and
 * kanji clause numbers, a heading with its first sentence on the same line.
 */
export interface DraftParagraph {
  readonly style?: string;
  readonly text: string;
}

export interface Draft {
  readonly file: string;
  /** The deal team whose folder holds the draft: `contracts/<team>/<file>`. */
  readonly team: string;
  readonly paragraphs: readonly DraftParagraph[];
  /** The planted issues: rule and clause (`null` for an absence) the check must report. */
  readonly planted: readonly (readonly [string, string | null])[];
}

/** Where the draft lives, in the workspace and under `data/`: its deal team's folder. */
export const contractPath = (draft: Draft): string => `contracts/${draft.team}/${draft.file}`;

const h = (text: string): DraftParagraph => ({ style: 'Heading2', text });
const p = (text: string): DraftParagraph => ({ text });

/** 業務委託契約書: 甲 is the client (the counterparty), 乙 is 当社. Six planted issues. */
export const SERVICE_AGREEMENT: Draft = {
  file: '業務委託契約書_株式会社ミナトシステムズ案.docx',
  team: '営業一部',
  paragraphs: [
    { style: 'Title', text: '業務委託契約書' },
    p(
      '株式会社ミナトシステムズ（以下「甲」という。）と株式会社サクラデータ（以下「乙」という。）は、甲が乙に委託する業務に関し、次のとおり契約（以下「本契約」という。）を締結する。',
    ),
    h('第1条（目的）'),
    p(
      '甲は、乙に対し、甲の基幹販売システムの保守及び改修業務（以下「本業務」という。）を委託し、乙はこれを受託する。',
    ),
    h('第2条（業務内容）'),
    p('本業務の内容、仕様及び納期は、甲乙協議のうえ個別契約に定める。'),
    h('第3条（委託料及び支払）'),
    p('甲は、本業務の対価として、個別契約に定める委託料を乙に支払う。'),
    p(
      '甲は、毎月末日締めで検収した成果物に係る委託料を、翌々月末日までに乙の指定する銀行口座に振り込む方法により支払う。',
    ),
    h('第4条（秘密保持）'),
    p(
      '甲及び乙は、本契約に関して知り得た相手方の技術上または営業上の情報を、相手方の書面による承諾なく第三者に開示または漏えいしてはならない。',
    ),
    p('本条に定める義務は、本契約の終了後も3年間存続する。'),
    h('第5条（知的財産権）'),
    p(
      '本業務の遂行により生じた成果物に関する著作権（著作権法第27条及び第28条の権利を含む。）その他一切の知的財産権、並びに乙が従前から保有する知的財産権のうち成果物に利用されたものは、成果物の納入時に乙から甲に譲渡され、甲に帰属する。',
    ),
    p('乙は、甲に対し、著作者人格権を行使しない。'),
    h('第6条（損害賠償）'),
    p(
      '乙は、本契約に違反して甲に損害を与えたときは、甲に生じた一切の損害（逸失利益及び弁護士費用を含む。）を賠償しなければならない。',
    ),
    h('第7条（契約の解除）'),
    p(
      '甲及び乙は、相手方が本契約に違反し、相当期間を定めて催告したにもかかわらず是正しないときは、本契約を解除することができる。',
    ),
    p(
      '甲は、理由の如何を問わず、乙に通知することにより、いつでも本契約の全部または一部を解除することができる。',
    ),
    h('第8条（有効期間）'),
    p(
      '本契約の有効期間は、2026年11月1日から1年間とする。期間満了後は、本契約は同一条件でさらに1年間自動的に更新されるものとし、以後も同様とする。',
    ),
    h('第9条（準拠法及び管轄）'),
    p(
      '本契約は日本法に準拠し、日本法に従って解釈される。本契約に関する一切の紛争については、東京地方裁判所を第一審の専属的合意管轄裁判所とする。',
    ),
    h('第10条（協議）'),
    p('本契約に定めのない事項は、甲乙誠実に協議のうえ解決する。'),
    p('本契約の成立を証するため、本書2通を作成し、甲乙記名押印のうえ各1通を保有する。'),
  ],
  planted: [
    ['PB-01', '第6条'],
    ['PB-03', '第7条'],
    ['PB-04', '第5条'],
    ['PB-05', '第8条'],
    ['PB-06', null],
    ['PB-08', '第3条'],
  ],
};

/**
 * 秘密保持契約書 from a US-parented counterparty: headings typed as body text with full-width
 * numbers. Planted: New York law and courts, a perpetual duty. Its 損害賠償 clause is the
 * playbook's standard text and its 反社 clause is present, so neither may be flagged.
 */
export const NDA: Draft = {
  file: '秘密保持契約書_Harborline Japan案.docx',
  team: '営業一部',
  paragraphs: [
    p('秘密保持契約書'),
    p(
      'ハーバーライン・ジャパン合同会社（以下「甲」という。）と株式会社サクラデータ（以下「乙」という。）は、両者間の業務提携の検討（以下「本目的」という。）に関し、次のとおり秘密保持契約（以下「本契約」という。）を締結する。',
    ),
    p('第１条（秘密情報）'),
    p(
      '本契約において「秘密情報」とは、本目的のために一方当事者が相手方に開示した技術上、営業上その他一切の情報であって、開示の際に秘密である旨を明示したものをいう。',
    ),
    p('第２条（秘密保持義務）'),
    p(
      '甲及び乙は、相手方の秘密情報を厳に秘密として保持し、相手方の事前の書面による承諾なく第三者に開示してはならない。',
    ),
    p('第３条（目的外使用の禁止）'),
    p('甲及び乙は、相手方の秘密情報を本目的以外に使用してはならない。'),
    p('第４条（返還及び廃棄）'),
    p(
      '甲及び乙は、相手方の求めがあったときは、秘密情報及びその複製物を速やかに返還または廃棄する。',
    ),
    p('第５条（損害賠償）'),
    p(
      '甲及び乙は、本契約に関し相手方に損害を与えたときは、相手方に現実に生じた通常かつ直接の損害に限り賠償する責任を負う。ただし、その賠償額は、金500万円を上限とする。前項の上限は、故意または重大な過失による損害には適用しない。',
    ),
    p('第６条（有効期間）'),
    p('本契約の有効期間は、本契約締結日から2年間とする。'),
    p('第２条及び第３条に定める義務は、本契約の終了後も永久に存続する。'),
    p('第７条（反社会的勢力の排除）'),
    p(
      '甲及び乙は、自己及び自己の役員が、暴力団、暴力団員、暴力団準構成員、総会屋その他の反社会的勢力に該当しないこと、及び将来にわたっても該当しないことを表明し、保証する。',
    ),
    p(
      '甲及び乙は、相手方が前項に違反したときは、何らの催告を要せず、直ちに本契約を解除することができる。この場合、解除した当事者は、相手方に生じた損害を賠償する責任を負わない。',
    ),
    p('第８条（準拠法及び管轄）'),
    p('本契約は、米国ニューヨーク州法に準拠し、同法に従って解釈される。'),
    p(
      '本契約に関する一切の紛争は、米国ニューヨーク州ニューヨーク郡に所在する裁判所を専属的合意管轄裁判所とする。',
    ),
    p('以上'),
  ],
  planted: [
    ['PB-02', '第8条'],
    ['PB-07', '第6条'],
  ],
};

/**
 * 売買基本契約書: 甲 is 当社 (the buyer), 乙 the supplier. Kanji clause numbers, one heading with
 * its first sentence on the same line. Mostly standard wording: renewal with a notice window,
 * mutual termination, a capped liability, a 反社 clause. Planted: a 90-day payment term and
 * subcontracting without consent.
 */
export const SUPPLY_AGREEMENT: Draft = {
  file: '売買基本契約書_北陸精工株式会社案.docx',
  team: '購買部',
  paragraphs: [
    { style: 'Title', text: '売買基本契約書' },
    p(
      '株式会社サクラデータ（以下「甲」という。）と北陸精工株式会社（以下「乙」という。）は、乙が製造する製品（以下「本製品」という。）の継続的売買に関し、次のとおり基本契約（以下「本契約」という。）を締結する。',
    ),
    h(
      '第一条（目的） 本契約は、甲乙間の本製品の個別の売買契約（以下「個別契約」という。）に共通する事項を定める。',
    ),
    h('第二条（個別契約）'),
    p('個別契約は、甲が注文書を乙に交付し、乙がこれを承諾したときに成立する。'),
    h('第三条（納入及び検収）'),
    p(
      '乙は、個別契約に定める納期までに本製品を甲の指定する場所に納入し、甲は納入後10営業日以内に検収を行う。',
    ),
    h('第四条（代金の支払）'),
    p(
      '甲は、検収が完了した本製品の代金を、検収完了日から90日以内に乙の指定する銀行口座に振り込む方法により支払う。',
    ),
    h('第五条（再委託）'),
    p(
      '乙は、甲の承諾を得ることなく、個別契約に基づく製造業務の全部または一部を第三者に再委託することができる。',
    ),
    h('第六条（契約不適合責任）'),
    p(
      '乙は、検収後1年以内に本製品に契約不適合が発見されたときは、甲の選択に従い、代替品の納入または修補を行う。',
    ),
    h('第七条（損害賠償）'),
    p(
      '甲及び乙は、本契約に関し相手方に損害を与えたときは、相手方に現実に生じた通常かつ直接の損害に限り賠償する責任を負う。ただし、その賠償額は、損害の原因となった事由が生じた日から遡って12か月間に本契約に基づき甲が乙に支払った対価の総額を上限とする。',
    ),
    h('第八条（解除）'),
    p(
      '甲及び乙は、相手方が次の各号のいずれかに該当したときは、何らの催告を要せず、直ちに本契約の全部または一部を解除することができる。(1) 本契約に違反し、相当期間を定めて催告したにもかかわらず是正しないとき (2) 支払停止もしくは支払不能となり、または破産手続開始の申立てがあったとき',
    ),
    h('第九条（反社会的勢力の排除）'),
    p(
      '甲及び乙は、自己及び自己の役員が、暴力団、暴力団員その他の反社会的勢力に該当しないことを表明し、保証する。相手方がこれに違反したときは、何らの催告を要せず、直ちに本契約を解除することができる。',
    ),
    h('第十条（有効期間）'),
    p(
      '本契約の有効期間は、本契約締結日から1年間とする。ただし、期間満了の3か月前までにいずれの当事者からも書面による更新拒絶の申出がないときは、本契約は同一条件でさらに1年間更新されるものとし、以後も同様とする。',
    ),
    h('第十一条（準拠法及び管轄）'),
    p(
      '本契約は日本法に準拠し、日本法に従って解釈される。本契約に関する一切の紛争については、東京地方裁判所を第一審の専属的合意管轄裁判所とする。',
    ),
    p('本契約の成立を証するため、本書2通を作成し、甲乙記名押印のうえ各1通を保有する。'),
  ],
  planted: [
    ['PB-08', '第4条'],
    ['PB-09', '第5条'],
  ],
};

export const DRAFTS: readonly Draft[] = [SERVICE_AGREEMENT, NDA, SUPPLY_AGREEMENT];
