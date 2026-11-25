# ja

## headline

機能の仕様書と自社のテスト設計の決まりから、計算例と不具合一覧にもとづくテストケースとテストコードの下書きを Word で作る。

## audience

機能のテストを設計する開発者、テストケースを見直す品質保証の担当者

## problem

仕様書が届くと、開発者が要件と計算例を読み、境界値や過去の不具合を思い出しながらテストケースとテストコードを書き起こしている。期待結果がどの記述にもとづくのかが残らず、見直す人が仕様書を読み直すことも多い。

## steps

1. [] 受け取る：機能の仕様書を受け取る。
2. [] 調べる：テスト設計の決まり、関数の仕様、不具合一覧から、仕様書に関係するものを探す。
3. [] 判断する：計算例と不具合ごとのテストケースと、テストコードの下書きを、根拠の ID 付きで回答に示す。
4. [] 人が確認する：Word のファイルを書き出す前に、担当者の承認を待つ。
5. [] 書き込む：承認された一回の書き出しで、テスト設計書を Word のファイルにする。

## outputs

- テストケースごとの要件、観点、入力、期待結果に、根拠にした計算例や不具合の ID を添えた一覧（回答の中に表示）
- 承認のあと書き出される、テストケースとテストコードの下書きをまとめた Word ファイル（.docx）
- 仕様書で決まっていないことを挙げた確認事項の一覧

## faq

### 期待結果を自分で計算しますか？

しません。期待結果は仕様書の計算例にある値だけを使い、計算例にない入力は「要確認」として確認事項に挙げます。

### テストを実行して、通ることまで確かめますか？

確かめません。テストコードは下書きで、実行していません。担当者が見直して実行します。

### 自社のテスト設計の決まりを使えますか？

テスト設計の決まり、関数の仕様、不具合一覧は、自社のフォルダに置くファイルです。差し替えると、その内容でテストケースを作ります。

## limits

- テストを実行せず、コードを直さない。
- 仕様書の計算例にない期待結果を書かない。
- 承認のない書き出しをせず、一回の承認で書き出すのは一つのファイルだけ。

# en

## headline

From a feature spec and your test design rules, drafts test cases sourced from the spec's examples and the defect list, with draft test code, as a Word file.

## audience

Developers who design tests for a feature, and QA staff who review test cases

## problem

When a spec arrives, a developer reads the requirements and examples and writes test cases and test code from them, remembering boundary values and past defects along the way. Which part of the spec each expected result rests on is not kept, so a reviewer often reads the spec again.

## steps

1. [] Receive: takes a feature spec.
2. [] Look up: finds what bears on the spec in the test design rules, the function reference and the defect list.
3. [] Decide: shows in the reply the test cases for each example and each defect, and the draft test code, with the ids they rest on.
4. [] A person confirms: waits for a person's approval before the Word file is written.
5. [] Write: turns the test design into a Word file in one approved render.

## outputs

- A list of test cases, each with its requirement, kind, input and expected result and the ids of the examples or defects it rests on (shown in the reply)
- A Word file (.docx) with the test cases and the draft test code, written after approval
- A list of open points the spec leaves undecided

## faq

### Does it compute expected results itself?

No. An expected result is only a value from the spec's examples; an input no example covers is marked "to be confirmed" and listed as an open point.

### Does it run the tests to check they pass?

No. The test code is a draft that has not been run. A developer reviews and runs it.

### Can it use our own test design rules?

The test design rules, the function reference and the defect list are files in your own folder. Replace them and it builds the test cases from what they say.

## limits

- Never runs tests or changes code.
- Never writes an expected result that is not in the spec's examples.
- Writes nothing without approval, and one approval writes one file only.
