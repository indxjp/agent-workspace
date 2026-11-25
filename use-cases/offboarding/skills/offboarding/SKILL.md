---
name: offboarding
description: 退職する人の返却物、引き継ぎ、権限の取り消しをチェックリストに照らして案にする決まり。何を返し、誰に引き継ぎ、どの権限をいつまでで削除するか。The rules for turning a leaver into returns, a handover and access removals the checklist calls for: what goes back, who takes over, which access is removed and from when.
---

# 退職手続きの案にする決まり / Rules for the proposal

決まりは `offboarding-checklist.md` の OFF-01〜OFF-06。書かれたとおりに当てはめ、決まりにない判断はしない。
The checklist is OFF-01 to OFF-06 in `offboarding-checklist.md`. Apply it as written; decide nothing
it does not say.

1. 対象の人 / Person: `leavers.csv` の氏名をそのまま `person` に使い、最終出社日、上長、引き継ぎ先を読む。
   Use the name exactly as in `leavers.csv`; read the last working day, the manager and the person
   taking over.
2. 返却物 / Returns: `equipment-loans.csv` のその人の行を、資産番号ごとに一行にする。返却先は総務部、
   期限は最終出社日（OFF-01）。 One row per asset number; returned to General Affairs by the last
   working day.
3. 引き継ぎ / Handover: 引き継ぎ先と上長の名前だけを示す。業務の中身は書かない（OFF-02）。
   Name the person taking over and the manager only.
4. 権限の取り消し / Removals: `current-access.csv` のその人の行を、ファイルの順に一件ずつ。`level` はいまの
   権限、`change` は `revoke`、`until` は最終出社日（OFF-03）。`list_grants` に同じシステムの取り消しが
   あれば、その一件は登録しない。 One removal per row, in file order: the level held, `revoke`, the
   last working day as `until`; skip one already in `list_grants`.
5. しないこと / Never: アカウントの削除、データの消去（OFF-04）。退職の理由、評価、再雇用の可否（OFF-05）。
   No account deletion or data erasure; no reason for leaving, assessment or rehire decision.
6. 根拠 / Source: 各行に、チェックリストの項目（OFF-0n）を示す。 Each row names its checklist item.
