# ja

## headline

会議室や社用車の予約を会話で受け付け、定員・重なり・運転許可を決まりに照らして確かめ、承認のあとに予約システムに登録する。

## audience

会議室や社用車の予約を受け付ける総務部の担当者、設備を使う各部署の社員

## problem

会議室や社用車の予約は、空きを見るだけでなく、人数が定員に収まるか、ほかの予約と重ならないか、運転する人に許可があるかを確かめてから入れる必要がある。総務部の担当者が問い合わせのたびに台帳と名簿を見比べていて、確認の漏れが起きやすい。

## steps

1. [] 受け取る：チャットで、使う設備の種類、日時、人数、予約者、用途を受け取る。
2. [] 調べる：設備予約の決まり、設備の一覧、いまの予約、運転許可者の名簿を照らし合わせる。
3. [] 判断する：決まりが認める設備を、開始、終了、予約者、用途、根拠の決まりをそろえた案にする。
4. [] 人が確認する：予約を登録する前に、人の承認を待つ。
5. [] 書き込む：承認された予約だけを、予約システムに登録する。

## outputs

- 設備、開始、終了、予約者、用途、根拠の決まりを並べた予約の案
- 案だけを求めたときの、型の決まった案（予約できるか、設備、時間、予約者、用途、根拠、理由）
- 承認のあと予約システムに登録される、一件の予約

## faq

### 空いていない設備を頼まれたらどうなりますか？

その設備は予約せず、同じ種類で定員が足り、その時間に空いている設備を案にします。空いている設備がなければ、そう伝えます。

### 自社の決まりや設備を使えますか？

決まり、設備の一覧、予約の書き出し、運転許可者の名簿は、自社のフォルダに置くファイルです。差し替えると、その内容で確かめます。

### すでにある予約を変更したり取り消したりできますか？

できません。既存の予約の変更や取り消しは、予約システムで予約した人が行います。

## limits

- 決まりが認めない予約（承認の要る設備、運転許可のない人の社用車など）を案にも登録にもしない。
- 承認のない予約を登録せず、一回の承認で登録するのは一件だけ。
- 既存の予約の変更や取り消しはしない。
- 出張の手配など、設備予約以外の作業はしない。

# en

## headline

Takes room and pool car bookings in chat, checks capacity, overlaps and driving permits against the rules, and books after a person approves.

## audience

General Affairs staff who take room and pool car bookings, and the employees who use them

## problem

Booking a room or a pool car means more than finding a free slot: someone has to check that the head count fits the capacity, that no other booking overlaps, and that the driver holds a permit. General Affairs compares the resource list and the driver list for every request, and a check is easy to miss.

## steps

1. [] Receive: takes, in chat, the type of resource, the date and time, the head count, who it is for and why.
2. [] Look up: checks the booking rules, the resource list, the current bookings and the driver list.
3. [] Decide: proposes a resource the rules allow, with the start, the end, who it is for, the purpose and the rule items.
4. [] A person confirms: waits for a person's approval before the booking is made.
5. [] Write: makes only the approved booking in the booking system.

## outputs

- A booking proposal with the resource, the start, the end, who it is for, the purpose and the rule items
- When only a proposal is asked for, a typed proposal (whether it can be booked, the resource, the times, who it is for, the purpose, the rules and the reason)
- One booking made in the booking system after approval

## faq

### What if the resource asked for is not free?

It does not book that resource, and proposes one of the same type with enough capacity that is free at that time. When none is free, it says so.

### Can it use our own rules and resources?

The rules, the resource list, the booking export and the driver list are files in your own folder. Replace them and it checks against what they say.

### Can it change or cancel an existing booking?

No. The person who made a booking changes or cancels it in the booking system.

## limits

- Never proposes or makes a booking the rules do not allow (a resource that needs approval, a pool car for someone without a permit).
- Makes no booking without approval, and one approval makes one booking only.
- Never changes or cancels an existing booking.
- Does no work other than facility booking, such as travel arrangements.
