---
name: account-requests
description: アクセス権限の申請を規程に照らして案にする決まり。誰に、どのシステムの、どの権限を、いつまで付けるか。The rules for turning an access request into changes the policy allows: who, which system, which level, until when.
---

# 権限の案にする決まり / Rules for the proposal

規程は `access-policy.md` の ACC-01〜ACC-06。書かれたとおりに当てはめ、規程にない判断はしない。
The policy is ACC-01 to ACC-06 in `access-policy.md`. Apply it as written; decide nothing it does
not say.

1. 対象の人 / Person: `employees.csv` の氏名をそのまま `person` に使う。役割（Role）と雇用区分
   （Employment）を読む。 Use the name exactly as in `employees.csv`; read the role and employment.
2. システムと権限 / System and level: システム名は規程の見出しのとおり（顧客管理システム、経費精算システム、
   会計システム / CRM, Expense system, Accounting system）。申請された権限が、その役割に規程が認める
   上限以内かを確かめる（read < write < admin）。`admin` は ACC-04 のとおり、役割がシステム管理者の人だけ。
   Check the level against the role's limit in the policy; `admin` only per ACC-04.
3. 期限 / Until: 派遣社員・契約社員は、人事データの契約終了日をそのまま `until` にする（ACC-05）。日付を計算しない。
   For agency or fixed-term staff, copy the contract end date into `until`; never compute a date.
4. 重複 / Duplicates: `current-access.csv` と `list_grants` に同じシステムの同じかそれ以上の権限があれば、
   登録せずにそう伝える。 If the person already has that level or higher, say so and change nothing.
5. 一件ずつ / One at a time: 一つのシステムの一つの権限が一件（ACC-06）。 One level on one system per call.
6. 根拠 / Source: 各行に規程の項目（ACC-0n）を示す。 Each row names the policy item it rests on.
