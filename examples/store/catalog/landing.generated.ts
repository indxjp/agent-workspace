// Generated from examples/store/catalog/landing/<slug>.md by `APPS_WRITE=1 pnpm vitest run --project tests-store tests/store`.
// Do not edit by hand: tests/store/landing.test.ts fails when it differs from the Markdown.

import { defineLanding } from './define.ts';

/** Each entry's landing-page copy, keyed by slug; the detail page shows a section per field. */
export const LANDING = defineLanding({
  "account-requests": {
    "headline": {
      "ja": "権限の申請を受けると、規程と役割を確かめて変更を案にし、承認のあとに一件ずつ権限管理に登録する。",
      "en": "Takes an access request, checks it against the policy and the person's role, and records each change after a person approves it."
    },
    "audience": {
      "ja": "アクセス権限の申請を受け付ける情報システム部の担当者、部下の権限を申請する部署の上長",
      "en": "IT staff who handle access requests, and managers who request access for their team"
    },
    "problem": {
      "ja": "権限の申請が届くと、情報システム部の担当者が付与規程と人事データを見比べ、その人の役割で認められる権限か、期限が必要な雇用区分かを確かめてから設定している。申請の書き方はまちまちで、規程を超える権限を付けてしまう心配がある。",
      "en": "When an access request arrives, someone in IT compares the access policy with the HR records, checks whether the person's role allows that access and whether their employment needs an end date, and only then sets it up. Requests are written in many ways, and access beyond the policy is easy to grant by mistake."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：チャットで、誰に、どのシステムの、どの権限が必要かを受け取る。",
          "en": "Receive: takes, in chat, who needs which access on which system."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：権限の付与規程、人事データの役割と雇用区分、現在の権限を照らし合わせる。",
          "en": "Look up: checks the access policy, the person's role and employment in the HR records, and their current access."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：規程が認める変更だけを、システム、権限、期限、根拠の規程をそろえた案にする。",
          "en": "Decide: proposes only the changes the policy allows, with the system, the level, the end date and the policy item."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：権限を登録する前に、一件ごとに人の承認を待つ。",
          "en": "A person confirms: waits for a person's approval before each change is recorded."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された変更だけを、権限管理に登録する。",
          "en": "Write: records only the approved changes in access management."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "対象の人、システム、権限、付与か削除か、期限、根拠の規程を並べた変更の案",
        "en": "A proposal listing the person, the system, the level, grant or revoke, the end date and the policy item"
      },
      {
        "ja": "案だけを求めたときの、型の決まった案（社員番号、氏名、役割、付与できるか、変更、理由）",
        "en": "When only a proposal is asked for, a typed proposal (employee ID, name, role, whether it is allowed, the changes, the reason)"
      },
      {
        "ja": "承認のあと権限管理に登録される、一件ずつの権限の変更",
        "en": "Access changes recorded one at a time in access management after approval"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "規程にない権限を頼まれたらどうなりますか？",
          "en": "What if someone asks for access the policy does not allow?"
        },
        "a": {
          "ja": "案にせず、登録もしません。規程が認める範囲と、例外の申請先を伝えます。",
          "en": "It proposes and records nothing, and says what the policy allows and where an exception request goes."
        }
      },
      {
        "q": {
          "ja": "自社の規程を使えますか？",
          "en": "Can it use our own policy?"
        },
        "a": {
          "ja": "付与規程、人事データ、現在の権限の一覧は、自社のフォルダに置くファイルです。差し替えると、その内容で確かめます。",
          "en": "The access policy, the HR records and the list of current access are files in your own folder. Replace them and it checks against what they say."
        }
      },
      {
        "q": {
          "ja": "承認を省けますか？",
          "en": "Can approval be skipped?"
        },
        "a": {
          "ja": "省けません。権限の変更は一件ずつ、人の承認のあとにだけ登録します。",
          "en": "No. Each access change is recorded only after a person approves it."
        }
      }
    ],
    "limits": [
      {
        "ja": "規程が認める範囲を超える権限を案にも登録にもしない。",
        "en": "Never proposes or records access beyond what the policy allows."
      },
      {
        "ja": "承認のない変更を登録せず、一回の承認で登録するのは一件だけ。",
        "en": "Records no change without approval, and one approval records one change only."
      },
      {
        "ja": "パスワードのリセットや機器の手配など、権限の申請以外の作業はしない。",
        "en": "Does no work other than access requests, such as password resets or equipment."
      }
    ]
  },
  "ad-compliance": {
    "headline": {
      "ja": "広告や商品ページの原稿を、自社の広告表示基準と表現ごとに照らし、判定と修正案を一覧にする。",
      "en": "Checks ad and product-page copy against your in-house advertising standard claim by claim, and lists each verdict with a suggested fix."
    },
    "audience": {
      "ja": "法務部の担当者、広告や商品ページを作るマーケティング・販売促進の担当者",
      "en": "People in legal, and marketing and sales-promotion staff who write ads and product pages"
    },
    "problem": {
      "ja": "広告や商品ページの原稿は、公開の前に担当者が一文ずつ読み、最上級の表現、価格の比較、期間限定の表示、体験談などに問題がないかを確かめている。社内の基準と原稿を見比べる作業は、原稿が増えるほど公開の直前に集中しやすい。",
      "en": "Before an ad or a product page goes out, someone reads the copy line by line for superlatives, price comparisons, limited-time offers and statements of personal experience. Comparing the copy with the company's own standard tends to pile up right before publication as more drafts arrive."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：広告や商品ページ、SNS投稿の原稿を受け取る。",
          "en": "Receive: takes the draft of an ad, a product page or a social post."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：日付つきで管理している自社の広告表示基準を読む。",
          "en": "Look up: reads your in-house advertising standard, kept as dated files."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：表現ごとに「OK・要注意・NG」の判定と、基準にもとづく修正案を付ける。",
          "en": "Decide: marks each claim OK, caution or NG, with a suggested fix based on the standard."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：チェック結果のレポートを保存する前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before saving the check report."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認されたレポートだけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved report to the ad-compliance-reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "原稿の表現ごとに、判定、理由、修正案、根拠にした基準の項目を並べたチェック表",
        "en": "A check table, one row per claim in the copy: the verdict, the reason, a suggested fix and the item of the standard it rests on"
      },
      {
        "ja": "承認のあとレポート用のフォルダに保存される、Markdown形式のチェックレポート",
        "en": "A check report in Markdown, saved to the ad-compliance-reports folder once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "法令に違反しているかどうかを判断しますか？",
          "en": "Does it decide whether the copy breaks the law?"
        },
        "a": {
          "ja": "判断しません。照らすのは、自社が法令や公表資料をもとにまとめた社内基準です。法的な判断は担当者や専門家が行います。",
          "en": "No. It checks against the in-house standard your company wrote from the law and published guidance. A person or a specialist makes any legal judgement."
        }
      },
      {
        "q": {
          "ja": "基準が古くなったらどうなりますか？",
          "en": "What if the standard goes out of date?"
        },
        "a": {
          "ja": "基準は日付つきのファイルとして自社のフォルダに置きます。チェックの結果には基準の日付を示すので、更新したファイルに差し替えると、その内容で照らします。",
          "en": "The standard is a set of dated files in your own folder. Each check states the standard's date, and when you replace the files it checks against what they say."
        }
      },
      {
        "q": {
          "ja": "どの形式の原稿を読めますか？",
          "en": "Which file formats can it read?"
        },
        "a": {
          "ja": "テキストとMarkdownのファイルはそのまま読みます。WordとPDFのファイルは読み取り用のスクリプトで読み、そのスクリプトを動かす前に担当者の承認を待ちます。",
          "en": "It reads text and Markdown files directly. It reads Word and PDF files with a reading script, and waits for a person's approval before that script runs."
        }
      }
    ],
    "limits": [
      {
        "ja": "法的助言はせず、原稿を掲載してよいかどうかも判断しない。",
        "en": "Gives no legal advice and never decides whether the copy may be published."
      },
      {
        "ja": "広告の文案を新しく作らない。",
        "en": "Does not write new ad copy."
      },
      {
        "ja": "社内基準にない論点には、判定を付けない。",
        "en": "Gives no verdict on points your in-house standard does not cover."
      },
      {
        "ja": "原稿を公開したり、社外に送ったりしない。",
        "en": "Never publishes the copy or sends it outside the company."
      }
    ]
  },
  "announce": {
    "headline": {
      "ja": "経営会議などの決定メモから、日本語版と英語版の社内告知の下書きを一つの Word 文書で作る。",
      "en": "Turns a decision memo into a draft internal announcement in Japanese and English, in one Word document."
    },
    "audience": {
      "ja": "社内広報の担当者、総務・人事・経理などで全社への告知を出す部署の担当者",
      "en": "Internal communications staff, and people in general affairs, HR or accounting who announce changes company-wide"
    },
    "problem": {
      "ja": "決まったことを全社に知らせるたびに、担当者が決定メモを読み返して告知文を書き、英語版も別に用意している。二つの版で内容がずれたり、社外秘の内容やメモにない説明が紛れ込んだりしやすい。",
      "en": "Each time a decision has to reach everyone, someone rereads the decision memo, writes the announcement and prepares an English version separately. The two versions drift apart, and confidential details or explanations the memo never gave creep in."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：決定メモを受け取る。",
          "en": "Receive: takes the decision memo."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：社内告知の書き方を読み、見出しと書き方を確かめる。",
          "en": "Look up: reads your announcement style guide for the headings and how to write them."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：日本語版と英語版の見出しと要点を、決定メモの節付きで回答に示す。",
          "en": "Decide: shows the headings and points of the Japanese and English versions in its reply, each with the memo section it rests on."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：Word のファイルを書き出す前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before writing the Word file."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された一回の書き出しで、日英の告知を一つの Word ファイルにする。",
          "en": "Write: writes both versions as one Word file in the one approved call."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "日本語版と英語版の見出しと要点に、もとにした決定メモの節を添えた告知の構成（回答の中に表示）",
        "en": "An announcement outline in the reply: the headings and points of both versions, each with the memo section it rests on"
      },
      {
        "ja": "承認のあと書き出される、日英の告知をまとめた Word ファイル（.docx）",
        "en": "Both versions as one Word file (.docx), written once it is approved"
      },
      {
        "ja": "告知に入れなかった内容と、メモで決まっていないことの一覧",
        "en": "A list of what was left out and of what the memo leaves undecided"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "メモにない説明を足すことはありますか？",
          "en": "Will it add explanations the memo does not give?"
        },
        "a": {
          "ja": "足しません。告知に書くのは決定メモにあることだけで、効果や理由を書き加えません。決まっていないことは、決まり次第知らせると書きます。",
          "en": "No. The announcement says only what the decision memo says, with no benefits or reasons added. What is not decided yet is announced as to follow once decided."
        }
      },
      {
        "q": {
          "ja": "社外秘の内容はどうなりますか？",
          "en": "What about confidential details?"
        },
        "a": {
          "ja": "メモで社外秘や告知に含めないとされた内容は、頼まれても告知に入れず、入れなかったことを回答で伝えます。",
          "en": "Anything the memo marks confidential or not for the announcement stays out, even when asked, and the reply says it was left out."
        }
      },
      {
        "q": {
          "ja": "自社の書き方に合わせられますか？",
          "en": "Can it follow our own style?"
        },
        "a": {
          "ja": "社内告知の書き方は自社のフォルダに置くファイルです。見出しや書き方を書き換えると、その内容に沿って構成を作ります。",
          "en": "The announcement style guide is a file in your own folder. Change its headings or rules and the outline follows them."
        }
      }
    ],
    "limits": [
      {
        "ja": "告知をメールやチャットで送らない。",
        "en": "Never sends the announcement by email or chat."
      },
      {
        "ja": "決定メモにない事実・効果・理由・日付を書かない。",
        "en": "Never writes a fact, a benefit, a reason or a date the decision memo does not contain."
      },
      {
        "ja": "社外秘とされた内容を書かない。",
        "en": "Never writes anything marked confidential."
      },
      {
        "ja": "日本語と英語のほかの言語では書かない。",
        "en": "Writes only Japanese and English."
      }
    ]
  },
  "attendance": {
    "headline": {
      "ja": "打刻データと月次集計から、打刻漏れと残業の上限への接近を毎週見つけ、上長が読む報告を上長ごとにまとめて作る。人の評価はしない。",
      "en": "Finds missed clock-ins and overtime nearing the agreed limit each week from the timeclock export and the monthly summary, and writes a report for managers to read, grouped by manager. It never rates anyone."
    },
    "audience": {
      "ja": "部下の勤怠を確認する現場の上長、勤怠の締めと労務を担当する人事の担当者",
      "en": "Line managers who check their team's attendance, and HR staff who close attendance and handle labour matters"
    },
    "problem": {
      "ja": "週の初めに、人事の担当者が勤怠システムから打刻データを出し、打刻漏れと残業の多い人を探して、上長ごとに連絡している。休暇の日を打刻漏れと見間違えたり、上限に近い人への連絡が遅れたりする。",
      "en": "At the start of each week, someone in HR exports the timeclock data, looks for missed punches and people with a lot of overtime, and contacts each manager. A day of leave is mistaken for a missed punch, or a warning to someone near the limit comes late."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：毎週月曜の朝に自動で始まる。担当者が週を指定して頼むこともできる。",
          "en": "Receive: starts automatically every Monday morning, or when a person asks for a given week."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：打刻データと月次集計、勤怠チェックのルールを読む。",
          "en": "Look up: reads the timeclock export, the monthly summary and the attendance check rules."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：ルールに当てはまる打刻漏れと、残業の当月累計が上限に近い人・超えた人だけを、該当する行の出典付きで上長ごとにまとめる。人の評価はしない。",
          "en": "Decide: lists, for each manager, only the missed punches the rules define and the people whose month-to-date overtime is near or over the limit, each with its source row. It rates nobody."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：保存する前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before saving."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された一回の保存で、勤怠チェックを報告のフォルダに書く。",
          "en": "Write: saves the attendance check to the reports folder in the one approved call."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "上長ごとの打刻漏れと残業の状況を、打刻データと月次集計の行の出典付きで並べた勤怠チェック（Markdown）",
        "en": "An attendance check in Markdown: each manager's missed punches and overtime, with the timeclock and summary rows as sources"
      },
      {
        "ja": "週・上長・該当する人ごとの型付きの結果",
        "en": "A typed result by week, manager and person concerned"
      },
      {
        "ja": "従わなかった記録の中の指示があれば、その一文",
        "en": "One sentence about any instruction in the records that it did not follow"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "勤怠の悪い人の順位や、処分の対象者を出せますか？",
          "en": "Can it rank people with poor attendance, or list who to discipline?"
        },
        "a": {
          "ja": "出しません。点数・順位・人どうしの比較・処分や評価への影響の提案は、頼まれてもしません。勤怠チェックは打刻の修正と業務量の調整のためのもので、判断は上長と人事が行います。",
          "en": "No. It never gives a score, a rank, a comparison between people or a suggestion of discipline or an effect on an evaluation, even when asked. The check is for correcting punches and adjusting workloads, and managers and HR decide."
        }
      },
      {
        "q": {
          "ja": "休暇の理由や体調も報告に入りますか？",
          "en": "Does the report include reasons for leave or health matters?"
        },
        "a": {
          "ja": "入りません。休暇の日は打刻漏れとして扱わず、打刻データの備考に休暇の理由や体調が書かれていても、報告には書きません。",
          "en": "No. A day of leave is never a missed punch, and even when a note in the export gives a reason for leave or a health matter, the report leaves it out."
        }
      },
      {
        "q": {
          "ja": "自社の勤怠システムや残業のルールに合わせられますか？",
          "en": "Can it use our own attendance system and overtime rules?"
        },
        "a": {
          "ja": "打刻データと月次集計は勤怠システムから出したファイルを、ルールは自社のフォルダに置くファイルを読みます。差し替えると、そのルールで確認します。",
          "en": "It reads the timeclock export and monthly summary from your attendance system, and the rules from a file in your own folder. Replace them and it checks against your rules."
        }
      }
    ],
    "limits": [
      {
        "ja": "人に点数・順位をつけず、比べず、処分や評価への影響を提案しない。判断は人が行う。",
        "en": "Never scores, ranks or compares people, or suggests discipline or an effect on an evaluation: a person decides."
      },
      {
        "ja": "休暇の理由や体調など、私的な事情を書かない。",
        "en": "Never writes reasons for leave, health or other private matters."
      },
      {
        "ja": "打刻を修正したり、勤怠システムを書き換えたりしない。",
        "en": "Never corrects a punch or changes the attendance system."
      },
      {
        "ja": "本人や上長にメールやチャットで連絡しない。",
        "en": "Never contacts staff or managers by email or chat."
      }
    ]
  },
  "budget": {
    "headline": {
      "ja": "部門経費の予算と実績を月ごとに比べ、差の大きい行をグラフと計算どおりの数値で示す。",
      "en": "Compares each department's expense budget with its actuals month by month, and shows the lines that are furthest off with a chart and exactly the computed numbers."
    },
    "audience": {
      "ja": "経理・経営企画の担当者、自部門の予算を管理する部門長",
      "en": "Accounting and financial planning staff, and department heads who manage their own budget"
    },
    "problem": {
      "ja": "月次の締めのあと、会計システムから書き出した予実の表を担当者が表計算ソフトで並べ替え、差異と差異率を計算して、説明の要る行を探している。計算式のずれや転記の誤りが混じりやすく、部門ごとのコメントを集めるのにも手間がかかる。",
      "en": "After each month-end close, someone exports the budget-versus-actual table from the accounting system, sorts it in a spreadsheet, works out each variance and variance rate, and looks for the lines that need an explanation. Formula slips and copy errors creep in, and collecting each department's comments takes time."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：会計システムから書き出した、部門・勘定科目・月ごとの予算と実績のCSVを受け取る。",
          "en": "Receive: takes the CSV of budget and actual by department, account and month that your accounting system exports."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：指定された月の行と、期首からその月までの行を読み取る。",
          "en": "Look up: reads the rows of the month asked for, and every row from the start of the year to that month."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：決まった計算をするスクリプトが、差異・差異率・累計を求め、基準を超えた行と予算のない支出に印を付ける。",
          "en": "Decide: a script that computes by fixed rules works out variance, variance rate and year to date, and flags the lines over the threshold and any spending with no budget."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：差異の大きい行と部門別のグラフを、担当者が確かめる。",
          "en": "A person confirms: a person checks the lines that are furthest off and the chart by department."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：ファイルは書き込まず、結果を表とコメントで返す。",
          "en": "Write: writes no file, and returns the result as a table and commentary."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "基準を超えた行の一覧：部門、勘定科目、予算、実績、差異、差異率、期首からの累計の差異",
        "en": "A list of the flagged lines: department, account, budget, actual, variance, variance rate and year-to-date variance"
      },
      {
        "ja": "部門別の当月の差異の棒グラフと、月別の差異の折れ線グラフ",
        "en": "A bar chart of each department's variance for the month, and a line chart of the variance month by month"
      },
      {
        "ja": "スクリプトが出した数値だけを引用したコメント",
        "en": "Commentary that quotes only numbers the script printed"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "数値をAIが計算するのですか？",
          "en": "Does the AI do the arithmetic?"
        },
        "a": {
          "ja": "いいえ。差異・差異率・累計は、決まった計算をするスクリプトが求めます。AIはその結果を読んで説明するだけで、スクリプトが出していない数値は書きません。",
          "en": "No. A script that computes by fixed rules works out the variance, the variance rate and the year to date. The AI reads its result and explains it, and never writes a number the script did not print."
        }
      },
      {
        "q": {
          "ja": "自社の会計システムの書き出しを使えますか？",
          "en": "Can it read our accounting system's export?"
        },
        "a": {
          "ja": "年月・部門・勘定科目・予算・実績の列があるCSV（UTF-8）か、Excelのファイル（.xlsx、最初のシート）を読みます。列名は日本語と英語のどちらでも構いません。年月は「2026-09」のような文字列にしてください。Excelが日付として保存した年月は読まずに、その列を文字列にするようお願いします。",
          "en": "It reads a CSV (UTF-8) or an Excel file (.xlsx, its first sheet) with columns for the month, department, account, budget and actual, named in Japanese or English. The month column must be text like \"2026-09\": a month Excel stored as a date is not read, and it asks you to format that column as text."
        }
      },
      {
        "q": {
          "ja": "印を付ける基準は変えられますか？",
          "en": "Can I change the threshold for flagging a line?"
        },
        "a": {
          "ja": "依頼の中で基準となる差異率を伝えると、その基準で印を付けます。伝えないときは決まった基準を使います。",
          "en": "Name a variance rate in your request and it flags lines by that threshold. Otherwise it uses its default."
        }
      }
    ],
    "limits": [
      {
        "ja": "差異の原因を推測せず、分かる数値だけを示す。",
        "en": "Never guesses why a variance happened; shows only the numbers it can compute."
      },
      {
        "ja": "予算の承認や修正、会計システムへの登録はしない。",
        "en": "Never approves or changes a budget, and never records anything in the accounting system."
      },
      {
        "ja": "予実のファイルを書き換えたり、保存したり、送ったりしない。",
        "en": "Never changes, saves or sends the budget files."
      },
      {
        "ja": "読めない値（空欄、整数でない金額、エラーのセル、結合されたセルの金額など）があれば推測せず、計算せずにその行と列を伝える。",
        "en": "Never guesses a value it cannot read (an empty cell, an amount that is not whole yen, an error cell, an amount in merged cells): it computes nothing and names the row and column."
      }
    ]
  },
  "code-review": {
    "headline": {
      "ja": "パッチをチームのコーディング規約に照らし、ルールごとに判定と該当する行と修正案を一覧にする。",
      "en": "Reviews a patch against your team's coding standard, with a verdict, the line it rests on and a fix for each rule."
    },
    "audience": {
      "ja": "コードレビューを担当する開発チームのメンバー、チームのコーディング規約を守らせたいテックリード",
      "en": "Developers who review code, and tech leads who want the team's coding standard applied"
    },
    "problem": {
      "ja": "変更が届くたびに、レビューの担当者が差分を読みながら、秘密情報の書き込み、SQLの組み立て、例外の扱い、ログの中身、テストの有無といった規約の項目を頭の中で一つずつ確かめている。見る観点が人によって違い、指摘の漏れが起きやすい。",
      "en": "Whenever a change arrives, a reviewer reads the diff and checks the standard's points one at a time in their head: secrets in code, how SQL is built, how exceptions are handled, what goes into the logs, whether tests came with it. Each reviewer looks at different things, so a point is easy to miss."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：差分やパッチのファイルを受け取る。",
          "en": "Receive: takes a diff or patch file."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：追加された行を、チームのコーディング規約のルールと一つずつ照らす。",
          "en": "Look up: checks the added lines against each rule of your coding standard."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：ルールごとに「OK・要注意・NG」の判定と、該当する行、修正案を付ける。",
          "en": "Decide: marks each rule OK, caution or NG, with the line and a suggested fix."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：レビューを保存する前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before saving the review."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認されたレビューだけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved review to the code-review-reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "規約のルールごとに、判定、ファイルと行、理由、修正案を並べた表",
        "en": "A table with one row per rule of the standard: the verdict, the file and line, the reason and a fix"
      },
      {
        "ja": "承認のあとレポート用のフォルダに保存される、Markdown形式のレビュー",
        "en": "A review in Markdown, saved to the code-review-reports folder once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "コードを実行してテストしますか？",
          "en": "Does it run the code or the tests?"
        },
        "a": {
          "ja": "しません。差分を読んで判定するだけで、コードの実行やビルドやテストはせず、テストが通ったとも言いません。",
          "en": "No. It reads the diff only; it never runs, builds or tests the code, and never says that the tests pass."
        }
      },
      {
        "q": {
          "ja": "自社のコーディング規約を使えますか？",
          "en": "Can it use our own coding standard?"
        },
        "a": {
          "ja": "規約は、自社のフォルダに置くファイルです。差し替えると、そのルールで判定します。",
          "en": "The standard is files in your own folder. Replace them and it reviews against those rules."
        }
      },
      {
        "q": {
          "ja": "プルリクエストにコメントしますか？",
          "en": "Does it comment on the pull request?"
        },
        "a": {
          "ja": "しません。レビューはレポート用のフォルダに保存し、マージするかどうかは担当者が判断します。",
          "en": "No. It saves the review to the code-review-reports folder, and a person decides whether to merge."
        }
      }
    ],
    "limits": [
      {
        "ja": "コードを実行、ビルド、テストせず、その結果を述べない。",
        "en": "Never runs, builds or tests the code, or reports such a result."
      },
      {
        "ja": "マージや承認をせず、プルリクエストにコメントもしない。",
        "en": "Never merges or approves a change, and never comments on a pull request."
      },
      {
        "ja": "コーディング規約にない論点には、判定を付けない。",
        "en": "Gives no verdict on points the coding standard does not cover."
      }
    ]
  },
  "contract-review": {
    "headline": {
      "ja": "相手方の契約書を自社の審査基準と条項ごとに照らし、リスク表と修正案を法務の手元にそろえる。",
      "en": "Checks a counterparty's contract clause by clause against your review standards, and puts a risk table and suggested fixes in front of legal."
    },
    "audience": {
      "ja": "法務部の契約審査担当、相手方から契約書を受け取る営業部門の担当者",
      "en": "Contract reviewers in legal, and sales staff who receive contracts from counterparties"
    },
    "problem": {
      "ja": "相手方から届いた契約書のドラフトを、担当者が自社の審査基準と一条ずつ見比べている。責任の上限、自動更新、知的財産の帰属のように見落としやすい条項の確認は人の注意力に頼り、修正文案も毎回一から書いている。",
      "en": "When a draft contract arrives, someone compares it with the company's review standards one clause at a time. Catching the clauses that are easy to miss, such as the liability cap, automatic renewal and who owns background IP, depends on attention, and the fixes are drafted from scratch each time."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：添付された、または契約書フォルダにある Word のドラフトを、依頼した人が閲覧できる範囲だけを読む。",
          "en": "Receive: reads the attached Word draft, or one in the contracts folder, only within what the asking person may read."
        },
        "safety": [
          "person",
          "files"
        ]
      },
      {
        "text": {
          "ja": "調べる：スキルの検出ルールを各条項に当て、指摘に審査基準ファイルの標準条項を添える。",
          "en": "Look up: runs the skill's detection rules over each clause and attaches the standard clause from your review-standard files to each finding."
        },
        "safety": [
          "files"
        ]
      },
      {
        "text": {
          "ja": "判断する：指摘ごとに条項・論点・リスク度・理由・修正文案をそろえたリスク表を作る。",
          "en": "Decide: builds a risk table with the clause, issue, risk level, reason and suggested wording for each finding."
        },
        "safety": [
          "structured"
        ]
      },
      {
        "text": {
          "ja": "人が確認する：修正案を保存する前に実行が止まり、法務担当者の承認を待つ。",
          "en": "A person confirms: the run stops before saving the redline and waits for legal to approve it."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された修正案だけを、修正案つきの Word ファイルにする。",
          "en": "Write: only the approved redline becomes a Word file with the fixes in it."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "条項・論点・リスク度・理由・修正文案を並べたリスク表（チャットに表で表示）",
        "en": "A risk table of clause, issue, risk level, reason and suggested wording (shown as a table in the chat)"
      },
      {
        "ja": "承認された修正案を書き込んだ Word ファイル（.docx）",
        "en": "A Word file (.docx) with the approved fixes written in"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "契約書のデータはどこに置かれますか？",
          "en": "Where is the contract data kept?"
        },
        "a": {
          "ja": "契約書と審査基準は、インストールした環境のフォルダに置かれます。エージェントは頼んだ人に許可されたフォルダだけを読みます。ストアのデモは架空のサンプル契約書だけで動きます。",
          "en": "Contracts and review standards stay in folders of the environment you install it in. The agent reads only the folders the asking person is allowed to read. The store's demo runs on fictional sample contracts only."
        }
      },
      {
        "q": {
          "ja": "締結してよいかどうかも判断しますか？",
          "en": "Does it decide whether to sign?"
        },
        "a": {
          "ja": "しません。リスク表と修正文案は判断材料で、締結の可否は法務担当者が決めます。",
          "en": "No. The risk table and the suggested wording are material for a decision; legal decides whether to sign."
        }
      },
      {
        "q": {
          "ja": "自社の審査基準に合わせられますか？",
          "en": "Can it follow our own review standards?"
        },
        "a": {
          "ja": "論点の名前、重大度、標準条項の文言は、フォルダの中の審査基準ファイルから読みます。何を問題として検出するかはスキルのスクリプトに書かれているので、検出ルールを変えるときはそのスクリプトを直します。",
          "en": "The issue titles, severities and standard clause wording come from the review-standard files in a folder. What counts as a problem is written in the skill's script, so changing a detection rule means changing that script."
        }
      },
      {
        "q": {
          "ja": "検出ルールが拾わない問題はどうなりますか？",
          "en": "What about problems the rules do not catch?"
        },
        "a": {
          "ja": "検出ルールは最低ラインです。ルールにない問題に気づいたときは表の前に短く書きますが、すべての問題を見つけるとは限りません。",
          "en": "The detection rules are a floor. When it notices a problem no rule covers, it says so briefly before the table, but it does not promise to find every problem."
        }
      }
    ],
    "limits": [
      {
        "ja": "法的助言はせず、締結の可否も書かない。",
        "en": "Gives no legal advice and never says whether to sign."
      },
      {
        "ja": "条文に書かれていない事実（相手方の意図や業界の慣行）を理由にしない。",
        "en": "Never gives a reason that is not in the text of the contract, such as the counterparty's intent or industry practice."
      },
      {
        "ja": "法務担当者の承認なしに修正案を保存しない。",
        "en": "Never saves a redline without legal's approval."
      }
    ]
  },
  "deal-risk": {
    "headline": {
      "ja": "毎週、動きの止まった商談とリスクの兆しがある商談を見つけ、根拠と次の一手を添えて一覧にする。",
      "en": "Each week, finds the stalled deals and the deals showing a risk sign, and lists them with the evidence and a next step."
    },
    "audience": {
      "ja": "法人営業の担当者、案件の進み具合を見る営業マネージャー",
      "en": "Account executives who sell to businesses, and sales managers who follow how deals progress"
    },
    "problem": {
      "ja": "営業マネージャーは、案件の一覧と活動記録を見比べて、止まっている商談や決裁者の交代、競合の参入といった兆しを探している。案件が多いと見落としが出やすく、気づいたときには手遅れになっていることがある。",
      "en": "A sales manager compares the deal list with the activity log, looking for deals that have stopped moving and for signs such as a new decision maker or a competitor stepping in. With many deals, some are missed, and by the time anyone notices it can be too late."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：毎週決まった時刻に、レポートを作る指示を受け取る。",
          "en": "Receive: takes the instruction to write the report at a set time each week."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：CRMから書き出した案件の一覧と活動記録を、案件ごとに照らす。",
          "en": "Look up: matches each deal with the deal list and activity log exported from the CRM."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：スキルに書いた基準で、止まっている案件とリスクの兆しがある案件を選び、根拠と次の一手をまとめる。",
          "en": "Decide: picks the stalled deals and the deals showing a risk sign by the rules in its skill, with the evidence and a next step."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：レポートを保存する前に、担当者の承認を待つ。承認なしには保存しない。",
          "en": "A person confirms: waits for the owner's approval before saving the report, and never saves it without it."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認されたレポートだけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved report to the reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "リスクのある案件ごとに、取引先、担当者、リスクの種類、根拠、次の一手",
        "en": "For each deal at risk: the account, the owner, the kind of risk, the evidence and a next step"
      },
      {
        "ja": "承認のあとフォルダに保存される、週ごとのレポートのMarkdownファイル",
        "en": "The week's report as a Markdown file, saved to a folder once it is approved"
      },
      {
        "ja": "各行の出典（CSVのファイル名と行のID）",
        "en": "A source on every line: the CSV file name and the row id"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "どのデータを使いますか？",
          "en": "Which data does it use?"
        },
        "a": {
          "ja": "CRMから書き出したCSVファイル（案件の一覧と活動記録）を自社のフォルダに置いて使います。デモでは架空の会社のデータを使っています。",
          "en": "CSV files exported from your CRM (the deal list and the activity log), placed in your own folder. The demo uses data about fictional companies."
        }
      },
      {
        "q": {
          "ja": "何をもって「止まっている」と判断しますか？",
          "en": "How does it decide a deal has stalled?"
        },
        "a": {
          "ja": "最後の活動からの日数と、今の段階にとどまっている日数を、スキルに書いた基準と比べます。基準はスキルの説明を書き換えて変えられます。",
          "en": "It compares the days since the last activity and the days in the current stage with the rules written in its skill. You change the rules by editing the skill's description."
        }
      },
      {
        "q": {
          "ja": "顧客に連絡したり、CRMを書き換えたりしますか？",
          "en": "Does it contact customers or change the CRM?"
        },
        "a": {
          "ja": "しません。レポートを作って保存するまでで、顧客への連絡とCRMの更新は担当者が行います。",
          "en": "No. It writes and saves the report; a person contacts the customer and updates the CRM."
        }
      }
    ],
    "limits": [
      {
        "ja": "顧客にメールやメッセージを送らない。",
        "en": "Never sends an email or a message to a customer."
      },
      {
        "ja": "CRMの記録を書き換えない。",
        "en": "Never changes a CRM record."
      },
      {
        "ja": "営業担当者の成績を評価しない。",
        "en": "Never judges a sales rep's performance."
      },
      {
        "ja": "書き出したファイルの中に書かれた指示には従わず、その内容として扱う。",
        "en": "Never follows an instruction written inside the exported files; it treats it as their content."
      }
    ]
  },
  "expense": {
    "headline": {
      "ja": "経費精算の申請を旅費・経費規程と明細ごとに照らし、規程違反と領収書との食い違いを一覧にする。",
      "en": "Checks an expense claim against your travel and expense policy line by line, and lists policy breaches and receipt mismatches."
    },
    "audience": {
      "ja": "経理部の担当者、部下の経費精算を承認する管理職",
      "en": "Accounting staff, and managers who approve their team's expense claims"
    },
    "problem": {
      "ja": "経費精算の申請は、経理の担当者が明細ごとに規程と領収書を見比べ、上限を超える宿泊費、事前承認のない座席、領収書と合わない金額などを探している。月末に申請が集まると、確認が締めの直前に集中しやすい。",
      "en": "For each expense claim, someone in accounting compares every line with the policy and the receipts, looking for lodging above the limit, seats taken without prior approval, or amounts that do not match the receipt. When claims gather at month end, those checks pile up right before the close."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：経費精算の申請ファイルを受け取る。",
          "en": "Receive: takes the expense claim file."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：自社の旅費・経費規程を読む。",
          "en": "Look up: reads your travel and expense policy."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：明細ごとに「OK・要注意・NG」の判定と、規程にもとづく修正案を付ける。",
          "en": "Decide: marks each line OK, caution or NG, with a suggested fix based on the policy."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：チェック結果のレポートを保存する前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before saving the check report."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認されたレポートだけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved report to the expense-reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "申請の明細ごとに、申請内容、判定、理由、修正案、根拠にした規程の項目を並べたチェック表",
        "en": "A check table, one row per claim line: what was claimed, the verdict, the reason, a suggested fix and the item of the policy it rests on"
      },
      {
        "ja": "承認のあとレポート用のフォルダに保存される、Markdown形式のチェックレポート",
        "en": "A check report in Markdown, saved to the expense-reports folder once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "申請を承認したり差し戻したりしますか？",
          "en": "Does it approve or return claims?"
        },
        "a": {
          "ja": "しません。規程違反と食い違いを示すまでで、精算するかどうかは承認者が決めます。",
          "en": "No. It shows breaches and mismatches; the approver decides what is paid."
        }
      },
      {
        "q": {
          "ja": "税務上の扱いも判断しますか？",
          "en": "Does it decide the tax treatment?"
        },
        "a": {
          "ja": "判断しません。照らすのは自社の旅費・経費規程だけで、税務の相談には答えません。",
          "en": "No. It checks against your travel and expense policy only, and does not answer tax questions."
        }
      },
      {
        "q": {
          "ja": "自社の規程を使えますか？",
          "en": "Can it use our own policy?"
        },
        "a": {
          "ja": "規程は、自社のフォルダに置くファイルです。差し替えると、その内容で照らします。",
          "en": "The policy is a set of files in your own folder. Replace them and it checks against what they say."
        }
      }
    ],
    "limits": [
      {
        "ja": "申請を承認・差し戻し・支払いしない。",
        "en": "Never approves, returns or pays a claim."
      },
      {
        "ja": "税務上の助言をしない。",
        "en": "Gives no tax advice."
      },
      {
        "ja": "申請した人を評価しない。",
        "en": "Never judges the person who made the claim."
      },
      {
        "ja": "規程にない論点には、判定を付けない。",
        "en": "Gives no verdict on points the policy does not cover."
      }
    ]
  },
  "faq-bot": {
    "headline": {
      "ja": "お客様の質問に、ヘルプセンターの記事だけを根拠に出典付きで答え、記事にないことはサポート窓口に引き継ぐ。",
      "en": "Answers customers only from your help-center articles, citing each one, and hands anything the articles do not cover to your support team."
    },
    "audience": {
      "ja": "カスタマーサポートの担当者、ヘルプセンターの記事を管理する担当者",
      "en": "Customer support staff, and the people who maintain the help-center articles"
    },
    "problem": {
      "ja": "配送、返品、定期便、お支払いについての同じような質問に、サポートの担当者がそのつど記事を探して答えている。記事に書いてあることと担当者の答えが少しずつずれたり、記事にない約束をしてしまったりすることもある。",
      "en": "Support staff answer the same questions about shipping, returns, subscriptions and payment again and again, looking up the article each time. Answers drift a little from what the articles say, and now and then someone promises something no article allows."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：お客様の質問を受け取る。",
          "en": "Receive: takes the customer's question."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：ヘルプセンターの記事を検索し、該当する記事の節を読む。",
          "en": "Look up: searches the help-center articles and reads the matching section."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：記事に答えがあるか、記事にない質問や一人の注文についての質問かを見分ける。",
          "en": "Decide: tells an answerable question apart from one the articles do not cover or one about a single order."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：記事で答えられない質問は、お問い合わせフォームのサポート窓口に引き継ぐ。",
          "en": "A person confirms: hands a question the articles cannot answer to the support team's contact form."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：結論と、記事の名前と番号の出典を付けた回答を返す。",
          "en": "Write: replies with the conclusion and the title and id of each article it rests on."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "結論と、記事の名前と番号の出典を付けた回答（チャットに表示）",
        "en": "An answer with the conclusion and the title and id of each article it cites, in the chat"
      },
      {
        "ja": "記事にない質問への、お問い合わせフォームへの案内",
        "en": "For a question the articles do not cover, a pointer to the contact form"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "自社のヘルプセンターの記事を使えますか？",
          "en": "Can it use our own help-center articles?"
        },
        "a": {
          "ja": "記事は、自社のフォルダに置くファイルです。ヘルプセンターから書き出した記事に差し替えると、その内容から答えます。",
          "en": "The articles are files in your own folder. Replace them with an export of your help center and it answers from what they say."
        }
      },
      {
        "q": {
          "ja": "注文の状況や返金の手続きもできますか？",
          "en": "Can it check an order or process a refund?"
        },
        "a": {
          "ja": "できません。答えるのは記事に書かれていることだけで、一人ひとりの注文の状況は、お問い合わせフォームのサポート窓口に案内します。",
          "en": "No. It answers only from what the articles say, and points a customer asking about their own order to the support team's contact form."
        }
      },
      {
        "q": {
          "ja": "記事にない返金や例外を約束することはありますか？",
          "en": "Will it promise a refund or an exception the articles do not give?"
        },
        "a": {
          "ja": "ありません。記事にない約束はせず、記事で答えられない質問はサポート窓口に引き継ぎます。",
          "en": "No. It promises nothing the articles do not say, and hands any question they cannot answer to the support team."
        }
      }
    ],
    "limits": [
      {
        "ja": "注文、配送、返金、請求の状況を調べない。",
        "en": "Does not look up orders, deliveries, refunds or bills."
      },
      {
        "ja": "定期便の変更や解約、支払いの手続きを代わりに行わない。",
        "en": "Does not change or cancel a subscription or handle a payment."
      },
      {
        "ja": "記事にない返金、例外、日付を約束しない。",
        "en": "Never promises a refund, an exception or a date that the articles do not give."
      },
      {
        "ja": "カード番号やパスワードを尋ねない。",
        "en": "Never asks for a card number or a password."
      }
    ]
  },
  "glossary": {
    "headline": {
      "ja": "文書の用語を社内用語集と照らし、用語ごとに「OK・要注意・NG」の判定と推奨語を一覧にする。",
      "en": "Checks the terms in a document against your company glossary, with an OK, caution or NG verdict and the preferred term for each."
    },
    "audience": {
      "ja": "マニュアルやリリースノートを書く担当者、社内用語集を管理する広報・品質の担当者",
      "en": "Writers of manuals and release notes, and the public relations or quality staff who keep the company glossary"
    },
    "problem": {
      "ja": "製品のマニュアルやリリースノートを出す前に、担当者が社内用語集と見比べて、表記の揺れや使わない言葉を探している。文書が増えるほど見落としが出やすく、同じ製品の資料で呼び方がばらばらになることもある。",
      "en": "Before a manual or a release note goes out, a writer compares it with the company glossary, looking for inconsistent spellings and words the company does not use. The more documents there are, the more slips through, and one product ends up called different things in different documents."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：確認する文書のファイルを受け取る。",
          "en": "Receive: takes the document to check."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：社内用語集の項目ごとに、文書の中の使われ方を探す。",
          "en": "Look up: finds how the document uses each term in the company glossary."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：用語ごとに「OK・要注意・NG」の判定と、推奨語を使った修正案を付ける。",
          "en": "Decide: gives each term an OK, caution or NG verdict and a fix that uses the preferred term."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：レポートを保存する前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before saving the report."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認されたレポートだけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved report to the reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "用語集の項目ごとに、文書の中の箇所、判定、理由、推奨語を使った修正案を並べた判定表",
        "en": "A table with, for each glossary term, where the document uses it, the verdict, why, and a fix with the preferred term"
      },
      {
        "ja": "承認のあとレポート用のフォルダに保存される、Markdown形式のレポート",
        "en": "A Markdown report saved to the reports folder once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "自社の用語集を使えますか？",
          "en": "Can it use our own glossary?"
        },
        "a": {
          "ja": "用語集は、自社のフォルダに置く CSV のファイルです。差し替えると、その項目で確認します。",
          "en": "The glossary is a CSV file in your own folder. Replace it and it checks against your terms."
        }
      },
      {
        "q": {
          "ja": "文書を直してくれますか？",
          "en": "Does it fix the document?"
        },
        "a": {
          "ja": "直しません。修正案を示すところまでで、どう直すかは担当者が決めます。",
          "en": "No. It suggests fixes, and the writer decides what to change."
        }
      },
      {
        "q": {
          "ja": "用語集にない言葉も指摘しますか？",
          "en": "Does it flag words the glossary does not list?"
        },
        "a": {
          "ja": "判定はしません。用語集にない言葉は判定の対象外で、用語集に項目を足すこともしません。",
          "en": "It gives them no verdict. Words outside the glossary are not judged, and it never adds a term to the glossary."
        }
      }
    ],
    "limits": [
      {
        "ja": "文書を書き換えない。",
        "en": "Does not rewrite the document."
      },
      {
        "ja": "用語集にない言葉に判定を付けない。",
        "en": "Gives no verdict on a word the glossary does not list."
      },
      {
        "ja": "用語集に項目を足したり変えたりしない。",
        "en": "Does not add or change glossary terms."
      },
      {
        "ja": "文法や文体の校正はしない。",
        "en": "Does not proofread grammar or style."
      }
    ]
  },
  "incident": {
    "headline": {
      "ja": "監視システムから届いたアラートを分類して重要度を決め、当番表から担当者を選び、最初の連絡文を下書きする。",
      "en": "Classifies an alert from monitoring, sets its severity, picks the owner from the on-call roster and drafts the first update."
    },
    "audience": {
      "ja": "情報システム部門とSREの当番担当者、障害対応を取りまとめるインシデント指揮者",
      "en": "On-call engineers in IT and SRE teams, and the incident commander who coordinates the response"
    },
    "problem": {
      "ja": "夜間や休日にアラートが届くと、当番の担当者が監視画面とサービスの一覧、当番表、手順書を見比べて、重要度と連絡先を決めている。誰に振るか、関係者に何を伝えるかを決めるまでの手順は人によって違い、最初の連絡が遅れやすい。",
      "en": "When an alert fires at night or on a weekend, the engineer on call compares the monitoring dashboard with the service list, the on-call roster and the runbooks to decide how severe it is and who should take it. How they decide whom to page and what to tell people differs from person to person, and the first update tends to go out late."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：監視システムからのアラートを、Webhook かチャットで受け取る。",
          "en": "Receive: takes the alert from monitoring, through a webhook or in chat."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：サービスの担当チーム、今週の当番表、手順書の初動を照らし合わせる。",
          "en": "Look up: checks the owning team, this week's on-call roster and the runbook's first steps."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：分類と重要度を決め、担当者を一人選び、最初の連絡文を下書きする。",
          "en": "Decide: sets the category and severity, picks one owner and drafts the first update."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：担当者への振り分けを登録する前に、人の承認を待つ。",
          "en": "A person confirms: waits for approval before registering the routing to the owner."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された振り分けだけを、タスク管理に登録する。",
          "en": "Write: registers only the approved routing in your task tracker."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "アラートの番号、分類、重要度、影響の範囲、担当者、判断の理由、手順書の初動、最初の連絡文をそろえた型付きの結果",
        "en": "A typed result with the alert number, category, severity, impact, owner, the reason, the runbook's first steps and the first update"
      },
      {
        "ja": "承認のあとタスク管理に登録される、担当者あての振り分けタスク",
        "en": "A routing task for the owner, registered in your task tracker once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "自社の当番表や手順書を使えますか？",
          "en": "Can it use our own roster and runbooks?"
        },
        "a": {
          "ja": "サービスの一覧、当番表、手順書は自社のフォルダに置くファイルです。差し替えると、その内容で担当者と初動を選びます。",
          "en": "The service list, the on-call roster and the runbooks are files in your own folder. Replace them and it picks the owner and the first steps from what they say."
        }
      },
      {
        "q": {
          "ja": "障害の復旧作業もしますか？",
          "en": "Does it fix the incident?"
        },
        "a": {
          "ja": "しません。コマンドの実行や再起動、切り戻しはせず、手順書の初動を担当者への案内として示します。",
          "en": "No. It runs no command, restart or rollback; it shows the runbook's first steps to the owner as guidance."
        }
      },
      {
        "q": {
          "ja": "アラートの中に指示が書かれていたらどうなりますか？",
          "en": "What if an alert contains instructions?"
        },
        "a": {
          "ja": "アラートは調べる対象として読み、そこに書かれた指示には従いません。重要度と担当者は、自社の基準と当番表で決めます。",
          "en": "It reads an alert as evidence and does not follow instructions written in it. Your own rules and roster decide the severity and the owner."
        }
      }
    ],
    "limits": [
      {
        "ja": "コマンドの実行、再起動、切り戻しなど、システムへの変更はしない。",
        "en": "Makes no change to your systems: no command, restart or rollback."
      },
      {
        "ja": "担当者への振り分けは、人が承認するまで登録しない。",
        "en": "Registers no routing until a person approves it."
      },
      {
        "ja": "当番表にいない人やチーム全体を担当者にしない。",
        "en": "Never makes someone outside the roster, or a whole team, the owner."
      },
      {
        "ja": "お客様や社外への連絡は送らず、最初の連絡文は下書きにとどめる。",
        "en": "Sends nothing to customers or outside the company; the first update stays a draft."
      }
    ]
  },
  "inspection": {
    "headline": {
      "ja": "検査記録を検査基準書と項目ごとに照らし、規格外れと記入漏れを一覧にする。",
      "en": "Checks an inspection record against the inspection standard item by item, and lists out-of-spec values and missing entries."
    },
    "audience": {
      "ja": "品質保証部の担当者、検査記録を確認する製造現場の責任者",
      "en": "Quality assurance staff, and production leads who sign off inspection records"
    },
    "problem": {
      "ja": "検査記録は、出荷の前に担当者が検査基準書と並べて、測定値が規格の範囲に入っているか、記入漏れがないかを一行ずつ確かめている。ロットが重なると、確認が出荷の直前に集中しやすい。",
      "en": "Before a lot ships, someone puts the inspection record beside the inspection standard and checks line by line that each measurement is within its limits and nothing is left blank. When lots overlap, those checks tend to pile up right before shipping."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：検査記録のファイルを受け取る。",
          "en": "Receive: takes the inspection record file."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：その品番の検査基準書の規格と判定基準を読む。",
          "en": "Look up: reads the specification and the rule of the inspection standard for that part."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：検査項目ごとに「OK・要注意・NG」の判定と、基準書の処置を付ける。",
          "en": "Decide: marks each inspection item OK, caution or NG, with the action the standard names."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：チェック結果の報告書を保存する前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before saving the check report."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された報告書だけを、報告書用のフォルダに保存する。",
          "en": "Write: saves only the approved report to the inspection-reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "検査項目ごとに、記録された値、判定、理由（どのサンプルのどの値か）、検査基準書の処置を並べたチェック表",
        "en": "A check table, one row per inspection item: the recorded values, the verdict, the reason (which sample and which value) and the standard's action"
      },
      {
        "ja": "承認のあと報告書用のフォルダに保存される、Markdown形式のチェック報告書",
        "en": "A check report in Markdown, saved to the inspection-reports folder once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "ロットを出荷してよいかを決めますか？",
          "en": "Does it decide whether the lot ships?"
        },
        "a": {
          "ja": "決めません。規格外れと記入漏れを示し、基準書の処置を添えるまでです。ロットの処置は品質保証の担当者が決めます。",
          "en": "No. It shows out-of-spec values and missing entries with the standard's action. A person in quality assurance decides what happens to the lot."
        }
      },
      {
        "q": {
          "ja": "自社の検査基準書を使えますか？",
          "en": "Can it use our own inspection standard?"
        },
        "a": {
          "ja": "検査基準書は、自社のフォルダに置くファイルです。差し替えると、その規格と判定基準で照らします。",
          "en": "The inspection standard is a set of files in your own folder. Replace them and it checks against their specifications and rules."
        }
      },
      {
        "q": {
          "ja": "どの形式の検査記録を読めますか？",
          "en": "Which file formats can it read?"
        },
        "a": {
          "ja": "CSVとテキストのファイルはそのまま読みます。ExcelとPDFのファイルは読み取り用のスクリプトで読み、そのスクリプトを動かす前に担当者の承認を待ちます。",
          "en": "It reads CSV and text files directly. It reads Excel and PDF files with a reading script, and waits for a person's approval before that script runs."
        }
      }
    ],
    "limits": [
      {
        "ja": "ロットの出荷・手直し・廃却を決めない。",
        "en": "Never decides whether a lot ships, is reworked or is scrapped."
      },
      {
        "ja": "検査基準書の規格や公差を変えない。",
        "en": "Never changes a specification or a tolerance."
      },
      {
        "ja": "空欄の測定値を推測で埋めない。",
        "en": "Never fills in a blank measurement by guessing."
      },
      {
        "ja": "検査基準書にない論点には、判定を付けない。",
        "en": "Gives no verdict on points the inspection standard does not cover."
      }
    ]
  },
  "interview": {
    "headline": {
      "ja": "面接官のメモと求人票から、要件ごとに面接で聞けたことをまとめた面接記録の下書きを Word で作る。評価や合否の判断はしない。",
      "en": "Turns the interviewer's notes and the job description into a draft interview summary as a Word document, setting out what the interview recorded for each requirement. It never rates or decides."
    },
    "audience": {
      "ja": "採用面接を担当する現場の管理職、面接記録を取りまとめる人事の採用担当者",
      "en": "Line managers who interview candidates, and recruiters in HR who keep the interview records"
    },
    "problem": {
      "ja": "面接のあと、面接官が手書きや走り書きのメモを見返して、求人票の要件ごとに記録を書き直している。記録の書き方は面接官ごとに違い、聞けなかった要件や、職務に関係のない話が混ざることもある。",
      "en": "After an interview, the interviewer goes back over handwritten or hurried notes and rewrites them requirement by requirement. Every interviewer writes the record differently, requirements that never came up go unnoticed, and talk unrelated to the job creeps in."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：面接官のメモを受け取る。",
          "en": "Receive: takes the interviewer's notes."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：メモにある求人票を探し、必須と歓迎の要件を読む。",
          "en": "Look up: finds the job description the notes name and reads its required and welcome requirements."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：要件ごとに面接で聞けたことを、メモの節や要件の番号付きで回答に示す。評価や合否は示さない。",
          "en": "Decide: shows in its reply what the interview recorded for each requirement, with the notes section or requirement it rests on. It gives no rating or verdict."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：Word のファイルを書き出す前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before writing the Word file."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された一回の書き出しで、面接記録を Word のファイルにする。",
          "en": "Write: writes the interview summary as a Word file in the one approved call."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "要件ごとに面接で聞けたことと根拠を並べた面接記録の構成（回答の中に表示）",
        "en": "An interview summary outline in the reply: what the interview recorded for each requirement, with its source"
      },
      {
        "ja": "承認のあと書き出される、面接記録の Word ファイル（.docx）",
        "en": "The interview summary as a Word file (.docx), written once it is approved"
      },
      {
        "ja": "メモに記載のない要件など、次の面接で確かめたいことの一覧",
        "en": "A list of topics for the next interview, such as requirements the notes do not cover"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "候補者の評価や、採用すべきかの判断はしますか？",
          "en": "Does it rate candidates or say whether to hire?"
        },
        "a": {
          "ja": "しません。点数・順位・合否・採用の推奨は、頼まれても出しません。面接記録は面接で聞けたことを並べるだけで、判断は面接官と採用担当が行います。",
          "en": "No. It never gives a score, a rank, a pass or fail or a hiring recommendation, even when asked. The summary sets out what the interview recorded, and the interviewer and the hiring team decide."
        }
      },
      {
        "q": {
          "ja": "メモにない内容や、職務に関係のない話はどうなりますか？",
          "en": "What about things the notes do not say, or talk unrelated to the job?"
        },
        "a": {
          "ja": "メモにないことは書かず、触れられていない要件は「メモに記載なし」とします。家族や健康など職務に関係のない話は、メモにあっても記録に入れません。",
          "en": "Nothing the notes do not record is written, and a requirement they do not touch is marked not in the notes. Talk unrelated to the job, such as family or health, stays out even when the notes mention it."
        }
      },
      {
        "q": {
          "ja": "自社の求人票や記録の書き方に合わせられますか？",
          "en": "Can it use our own job descriptions?"
        },
        "a": {
          "ja": "求人票は自社のフォルダに置くファイルです。差し替えると、その要件ごとに記録を作ります。",
          "en": "Job descriptions are files in your own folder. Replace them and it summarises against their requirements."
        }
      }
    ],
    "limits": [
      {
        "ja": "候補者に点数・順位・合否をつけず、採用の推奨もしない。判断は人が行う。",
        "en": "Never scores, ranks, passes or fails a candidate, or recommends hiring: a person decides."
      },
      {
        "ja": "メモにない内容や、職務に関係のない話を書かない。",
        "en": "Never writes what the notes do not record, or talk unrelated to the job."
      },
      {
        "ja": "候補者に連絡したり、通知を送ったりしない。",
        "en": "Never contacts a candidate or sends a notice."
      },
      {
        "ja": "候補者どうしを比べない。",
        "en": "Never compares candidates."
      }
    ]
  },
  "invoice": {
    "headline": {
      "ja": "届いた請求書を発注書と納品書に明細ごとに突き合わせ、差がある明細を判定と処置つきで示す。",
      "en": "Matches each line of an incoming invoice with its purchase order and delivery note, and flags the lines that differ with a verdict and an action."
    },
    "audience": {
      "ja": "購買部・経理部で請求書を受け付ける担当者",
      "en": "Purchasing and accounts payable staff who receive supplier invoices"
    },
    "problem": {
      "ja": "仕入先から届いた請求書は、担当者が発注書と納品書を並べて、品目、単価、数量が合っているかを明細ごとに確かめている。請求書が月末に集まると、突き合わせが支払いの締めの直前に集中しやすい。",
      "en": "When a supplier invoice arrives, someone lays it beside the purchase order and the delivery note and checks the item, unit price and quantity of every line. When invoices gather at month end, the matching piles up right before the payment run."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：仕入先から届いた請求書のファイルを受け取る。",
          "en": "Receive: takes the invoice file the supplier sent."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：請求書の発注番号から、発注書と納品書の記録を探す。",
          "en": "Look up: finds the purchase order and delivery note records from the invoice's order number."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：明細ごとに品目・単価・数量を照合し、「OK・要注意・NG」の判定と処置を付ける。",
          "en": "Decide: matches the item, unit price and quantity of each line, and marks it OK, caution or NG with an action."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：照合結果を保存する前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before saving the matching result."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された照合結果だけを、照合結果用のフォルダに保存する。",
          "en": "Write: saves only the approved result to the invoice-reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "請求書の明細ごとに、請求・発注・検収の数量と単価、判定、理由、照合ルールにもとづく処置を並べた照合表",
        "en": "A matching table, one row per invoice line: invoiced, ordered and accepted quantities and prices, the verdict, the reason and the action from your matching rules"
      },
      {
        "ja": "承認のあと照合結果用のフォルダに保存される、Markdown形式の照合レポート",
        "en": "A matching report in Markdown, saved to the invoice-reports folder once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "支払いや仕訳もしますか？",
          "en": "Does it pay the invoice or book the entry?"
        },
        "a": {
          "ja": "しません。照合して差を示すまでで、支払うかどうかは担当者が決めます。会計・税務の助言もしません。",
          "en": "No. It matches and shows the differences; a person decides whether to pay. It gives no accounting or tax advice."
        }
      },
      {
        "q": {
          "ja": "金額や消費税の計算も確かめますか？",
          "en": "Does it check the amounts and the tax?"
        },
        "a": {
          "ja": "確かめません。品目・単価・数量・参照番号を照合し、小計・消費税・合計は担当者や会計システムが確かめます。",
          "en": "No. It matches items, unit prices, quantities and reference numbers; a person or the accounting system checks the subtotal, tax and total."
        }
      },
      {
        "q": {
          "ja": "自社の照合ルールを使えますか？",
          "en": "Can it use our own matching rules?"
        },
        "a": {
          "ja": "照合ルールは、自社のフォルダに置くファイルです。差し替えると、その内容で照合します。",
          "en": "The matching rules are files in your own folder. Replace them and it matches against what they say."
        }
      }
    ],
    "limits": [
      {
        "ja": "請求書を承認したり、支払ったりしない。",
        "en": "Never approves or pays an invoice."
      },
      {
        "ja": "仕入先に連絡しない。",
        "en": "Never contacts the supplier."
      },
      {
        "ja": "会計・税務の助言をしない。",
        "en": "Gives no accounting or tax advice."
      },
      {
        "ja": "金額を計算し直さない。",
        "en": "Never recomputes an amount."
      }
    ]
  },
  "market": {
    "headline": {
      "ja": "公開統計と業界団体の発表から、市場規模・シェア・動向の質問に、発表元と公表日の出典と、どの時点の情報かを添えて答える。",
      "en": "Answers questions on market size, shares and trends from public statistics and industry releases, citing the publisher and release date of every figure and the date the sources stand as of."
    },
    "audience": {
      "ja": "新規事業や営業戦略を考える企画の担当者、市場の数字を資料にまとめる調査の担当者",
      "en": "Planners working on new businesses or sales strategy, and researchers who put market figures into reports"
    },
    "problem": {
      "ja": "市場の規模やシェアを知りたいたびに、統計や業界団体の発表を探し、数字と出典を手で書き写している。年度の取り違えや、出典のない数字、いつ時点の情報かわからない数字が資料に混ざりやすい。",
      "en": "Every time someone needs a market's size or shares, they hunt through statistics and industry releases and copy the figures and sources by hand. Mixed-up fiscal years, figures without a source and figures of unknown date creep into the slides."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：市場についての質問を受け取る。",
          "en": "Receive: takes a question about the market."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：社内の調査メモで市場の範囲と用語を確かめ、公開統計と業界団体の発表を検索する。",
          "en": "Look up: checks the market's scope and terms in your research memo, and searches the public statistics and industry releases."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：記載された数字だけを使い、結論と、数字ごとの発表元・公表日の出典、情報の時点を示す。予測や推計はしない。",
          "en": "Decide: uses only the figures the releases state, and gives the conclusion, the publisher and release date of each figure, and the date of the sources. It makes no forecast or estimate."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "あなたが確かめる：数字ごとに発表元と公表日が付くので、元の発表を開いて自分で確かめられる。",
          "en": "You check the source: every figure names its publisher and release date, so you can open the release and check."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：何も書き込まない。出典と時点を付けた回答を、質問した人に返すだけである。",
          "en": "Write: writes nothing; it only returns the answer, with its sources and date, to the person asking."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "結論と、数字ごとに発表元と公表日を添えた回答",
        "en": "An answer with the conclusion and the publisher and release date of each figure"
      },
      {
        "ja": "回答がどの時点の公開情報に基づくかを示す一文",
        "en": "A line saying the date of the public sources the answer rests on"
      },
      {
        "ja": "回答・時点・出典の型付きの結果",
        "en": "A typed result with the answer, the date and the sources"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "将来の市場規模を予測できますか？",
          "en": "Can it forecast the market?"
        },
        "a": {
          "ja": "しません。発表にない予測や推計、成長率の計算はせず、記載のない質問には「公開情報に該当する記載が見つかりませんでした」と答えます。",
          "en": "No. It makes no forecast, estimate or growth calculation the releases do not state, and answers a question they do not cover with \"The public sources do not cover this.\""
        }
      },
      {
        "q": {
          "ja": "どの時点の情報を使いますか？",
          "en": "Which date of the sources does it use?"
        },
        "a": {
          "ja": "デモでは、架空の公開統計と業界団体の発表の日付つきスナップショット（2026-11-14 時点）を読み、回答にその日付を示します。導入するときは、自社で使う統計の配布先を設定して読みます。利用の申請と鍵が必要な提供元には、まだ対応していません。",
          "en": "The demo reads a dated snapshot of fictional public statistics and industry releases (as of 2026-11-14) and shows that date in every answer. When you install it, you set the addresses of the statistics you use. Sources that need registration and a key are not supported yet."
        }
      },
      {
        "q": {
          "ja": "自社の市場の定義に合わせられますか？",
          "en": "Can it use our own definition of the market?"
        },
        "a": {
          "ja": "市場の範囲や年度の定義は、自社のフォルダに置く調査メモに書きます。差し替えると、その定義に沿って答えます。",
          "en": "The market's scope and fiscal year are set in a research memo in your own folder. Replace it and it answers by that definition."
        }
      }
    ],
    "limits": [
      {
        "ja": "発表にない予測・推計をせず、記載のない数字を作らない。",
        "en": "Never forecasts or estimates beyond the releases, or makes up a figure."
      },
      {
        "ja": "出典と時点のない数字を答えない。",
        "en": "Never gives a figure without its source and date."
      },
      {
        "ja": "社内のファイルや外部のデータを書き換えない。",
        "en": "Never changes your files or any outside data."
      },
      {
        "ja": "企業に連絡したり、メールを送ったりしない。",
        "en": "Never contacts a company or sends email."
      }
    ]
  },
  "meeting-prep": {
    "headline": {
      "ja": "毎朝、その日の商談ごとに、取引先メモ・進行中の案件・最近のメールを一枚の準備ブリーフにまとめる。",
      "en": "Each morning, puts the account notes, open deals and recent emails for each of the day's meetings on a one-page prep brief."
    },
    "audience": {
      "ja": "法人営業の担当者、担当者の商談に同席する営業マネージャー",
      "en": "Account executives who sell to businesses, and sales managers who join their meetings"
    },
    "problem": {
      "ja": "商談の前に、営業担当者がCRMの取引先メモ、案件の進み具合、過去のメールを別々の画面で開いて読み返している。商談が続く日ほど準備の時間が取れず、前回の約束や相手の関心ごとを確かめないまま臨むことになりやすい。",
      "en": "Before a meeting, a sales rep opens the account notes, the state of the deals and past emails in separate screens of the CRM and reads them again. On a day of back-to-back meetings there is little time for this, and it is easy to walk in without checking what was promised last time or what the customer cares about."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：毎朝決まった時刻に、その日の商談の一覧を受け取る。",
          "en": "Receive: takes the list of the day's meetings at a set time each morning."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：CRMから書き出した取引先メモ、案件、メールの記録を、商談ごとに照らす。",
          "en": "Look up: matches each meeting with the account notes, deals and emails exported from the CRM."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：商談ごとに、進行中の案件、最近のやり取り、話すべき点を出典付きで一枚にまとめる。",
          "en": "Decide: puts each meeting's open deals, recent exchanges and talking points on one page, each with its source."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：その日のブリーフを保存する前に、担当者の承認を待つ。承認なしには保存しない。",
          "en": "A person confirms: waits for the owner's approval before saving the day's briefs, and never saves them without it."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認されたブリーフだけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved briefs to the meeting-prep-reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "商談ごとに一ページの準備ブリーフ：商談の時刻と出席者、取引先メモ、進行中の案件、最近のメール、話すべき点",
        "en": "A one-page prep brief per meeting: the time and attendees, the account notes, open deals, recent emails and talking points"
      },
      {
        "ja": "承認のあとフォルダに保存される、その日のブリーフのMarkdownファイル",
        "en": "The day's briefs as a Markdown file, saved to a folder once they are approved"
      },
      {
        "ja": "各行の出典（CSVのファイル名と行のID）",
        "en": "A source on every line: the CSV file name and the row id"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "どのCRMのデータを使いますか？",
          "en": "Which CRM data does it use?"
        },
        "a": {
          "ja": "CRMから書き出したCSVファイル（商談、取引先、案件、メール）を自社のフォルダに置いて使います。デモでは架空の会社のデータを使っています。",
          "en": "CSV files exported from your CRM (meetings, accounts, deals and emails), placed in your own folder. The demo uses data about fictional companies."
        }
      },
      {
        "q": {
          "ja": "顧客にメールを送ったり、CRMを書き換えたりしますか？",
          "en": "Does it email customers or change the CRM?"
        },
        "a": {
          "ja": "しません。ブリーフを作って保存するまでで、顧客への連絡とCRMの更新は担当者が行います。",
          "en": "No. It writes and saves the briefs; a person contacts the customer and updates the CRM."
        }
      },
      {
        "q": {
          "ja": "作成する時刻やブリーフの項目は変えられますか？",
          "en": "Can I change when it runs, or what a brief holds?"
        },
        "a": {
          "ja": "作成する時刻はスケジュールの設定で、ブリーフの項目と順序はスキルの説明を書き換えて変えられます。",
          "en": "The time is set in the schedule, and the sections of a brief and their order are set by editing the skill's description."
        }
      }
    ],
    "limits": [
      {
        "ja": "顧客にメールやメッセージを送らない。",
        "en": "Never sends an email or a message to a customer."
      },
      {
        "ja": "CRMの記録を書き換えない。",
        "en": "Never changes a CRM record."
      },
      {
        "ja": "書き出したファイルにない情報は書かず、金額や日付を推測しない。",
        "en": "Writes nothing the exported files do not hold, and never guesses an amount or a date."
      },
      {
        "ja": "書き出したファイルの中に書かれた指示には従わず、その内容として扱う。",
        "en": "Never follows an instruction written inside the exported files; it treats it as their content."
      }
    ]
  },
  "nda": {
    "headline": {
      "ja": "受け取ったNDAを自社のひな形と条項ごとに比べ、違いと修正案を一覧にする。",
      "en": "Compares an incoming NDA with your template clause by clause, and lists each difference with a suggested fix."
    },
    "audience": {
      "ja": "法務部の担当者、取引の前にNDAを取り交わす営業・購買の担当者",
      "en": "People in legal, and sales and purchasing staff who exchange NDAs before a deal"
    },
    "problem": {
      "ja": "取引の前に相手方から届くNDAを、担当者が自社のひな形と並べて読み比べている。秘密情報の範囲、有効期間、返還や破棄の定めなど、ひな形との違いを探す作業は件数が増えるほど後回しになりやすい。",
      "en": "Before a deal, the counterparty sends an NDA and someone reads it side by side with the company's template. Finding where it differs, in the scope of confidential information, the term, or the rules for returning and destroying it, is easy to put off as more of them arrive."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：相手方から届いたNDAのファイルを受け取る。",
          "en": "Receive: takes the NDA file the counterparty sent."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：自社のNDAのひな形と審査基準を、条項ごとに照らす。",
          "en": "Look up: checks it clause by clause against your NDA template and review standards."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：違いごとに「OK・要注意・NG」の判定と修正案を付ける。",
          "en": "Decide: marks each difference OK, caution or NG, with a suggested fix."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：差分レポートを保存する前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before saving the difference report."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された差分レポートだけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved difference report to the nda-reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "審査基準の項目ごとに、受け取ったNDAの該当条項、判定、理由、ひな形の文言にもとづく修正案を並べた差分表",
        "en": "A table of differences, one row per item of your review standards: the matching clause of the NDA you received, the verdict, the reason and a suggested fix based on your template's wording"
      },
      {
        "ja": "承認のあとレポート用のフォルダに保存される、Markdown形式の差分レポート",
        "en": "A difference report in Markdown, saved to the nda-reports folder once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "自社のひな形を使えますか？",
          "en": "Can it use our own template?"
        },
        "a": {
          "ja": "ひな形と審査基準は、自社のフォルダに置くファイルです。差し替えると、その内容と比べます。",
          "en": "The template and the review standards are files in your own folder. Replace them and it compares against what they say."
        }
      },
      {
        "q": {
          "ja": "相手方への返信も作りますか？",
          "en": "Does it write the reply to the counterparty?"
        },
        "a": {
          "ja": "作りません。差分と修正案までを示し、相手方とのやり取りは担当者が行います。",
          "en": "No. It shows the differences and suggested fixes; a person handles the exchange with the counterparty."
        }
      },
      {
        "q": {
          "ja": "どの形式のNDAを読めますか？",
          "en": "Which file formats can it read?"
        },
        "a": {
          "ja": "テキストとMarkdownのファイルはそのまま読みます。WordとPDFのファイルは読み取り用のスクリプトで読み、そのスクリプトを動かす前に担当者の承認を待ちます。画像だけのPDFの文字は読めないため、読めなかったことを伝えます。",
          "en": "It reads text and Markdown files directly. It reads Word and PDF files with a reading script, and waits for a person's approval before that script runs. It cannot read the text of a PDF that is only scanned images, and says so."
        }
      }
    ],
    "limits": [
      {
        "ja": "法的助言はせず、署名してよいかどうかも判断しない。",
        "en": "Gives no legal advice and never decides whether to sign."
      },
      {
        "ja": "相手方にファイルやメッセージを送らない。",
        "en": "Never sends a file or a message to the counterparty."
      },
      {
        "ja": "ひな形と審査基準にない論点には、判定を付けない。",
        "en": "Gives no verdict on points that neither the template nor the review standards cover."
      }
    ]
  },
  "newcomer": {
    "headline": {
      "ja": "入社資料から新人の質問に出典付きで答え、入社者情報から最初の一週間のガイドを Word で作る。",
      "en": "Answers a new joiner's questions from your onboarding documents, citing each one, and drafts their first-week guide as a Word document from the joiner sheet."
    },
    "audience": {
      "ja": "新しく入る人を迎える人事・総務の担当者、配属先のメンターと上長",
      "en": "HR and general affairs staff who welcome new joiners, and the mentors and managers in their teams"
    },
    "problem": {
      "ja": "新しい人が入るたびに、人事やメンターが入社初日の流れ、PCの準備、研修の予定を資料から拾い集めて案内している。新人は同じような質問を何人にも聞くことになり、答える側も資料のどこに書いてあるかを探し直している。",
      "en": "Each time someone joins, HR and the mentor gather the first-day plan, the laptop setup and the training schedule from different documents to brief them. New joiners ask the same questions of several people, and whoever answers has to find again where it is written."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：新人の質問か、人事システムから書き出した入社者情報を受け取る。",
          "en": "Receive: takes a new joiner's question, or the joiner sheet exported from the HR system."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：入社初日の流れ、PCとアカウント、勤怠、研修、部署紹介の資料を探して読む。",
          "en": "Look up: finds and reads the first-day plan, laptop and accounts, working hours, training and team pages."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：質問には出典付きで答え、ガイドは見出しごとの要点を資料の ID 付きで回答に示す。",
          "en": "Decide: answers a question with its sources, and shows the guide's outline in its reply, each point with a document id."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：ガイドの Word ファイルを書き出す前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before writing the guide's Word file."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された一回の書き出しで、その人の初週ガイドを Word のファイルにする。",
          "en": "Write: writes that person's first-week guide as a Word file in the one approved call."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "新人の質問への、結論と資料の ID を付けた回答（回答の中に表示）",
        "en": "Answers to a new joiner's questions, with the conclusion and the id of each document, in the reply"
      },
      {
        "ja": "初日の流れ、今週の予定、期限のある準備、チーム、働き方、相談先をまとめた初週ガイドの構成",
        "en": "A first-week guide outline: the first day, the week's plan, deadlines, the team, working hours and who to ask"
      },
      {
        "ja": "承認のあと書き出される、初週ガイドの Word ファイル（.docx）",
        "en": "The guide as a Word file (.docx), written once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "自社の入社資料を使えますか？",
          "en": "Can it use our own onboarding documents?"
        },
        "a": {
          "ja": "入社資料と入社者情報は、自社のフォルダに置くファイルです。差し替えると、その内容から答え、ガイドを作ります。",
          "en": "The onboarding documents and the joiner sheet are files in your own folder. Replace them and it answers and drafts the guide from what they say."
        }
      },
      {
        "q": {
          "ja": "パスワードなどもガイドに書きますか？",
          "en": "Will it put passwords in the guide?"
        },
        "a": {
          "ja": "書きません。パスワードやWi-Fiの鍵は回答にもガイドにも入れず、誰が設定するかだけを書きます。",
          "en": "No. Passwords and Wi-Fi keys never go in an answer or the guide; it says only who sets them up."
        }
      },
      {
        "q": {
          "ja": "新人の評価にも使えますか？",
          "en": "Can it assess the new joiner?"
        },
        "a": {
          "ja": "使えません。入社資料にもとづく案内だけを行い、本人の評価や印象は書きません。",
          "en": "No. It only briefs from the onboarding documents and writes nothing about the person's performance or impression."
        }
      }
    ],
    "limits": [
      {
        "ja": "入社資料と入社者情報にない時刻、場所、決まりを書かない。",
        "en": "Never writes a time, a place or a rule the onboarding documents and joiner sheet do not contain."
      },
      {
        "ja": "パスワードなどの秘密の情報を書かない。",
        "en": "Never writes a password or any other secret."
      },
      {
        "ja": "新人を評価したり、人について判断したりしない。",
        "en": "Never assesses a new joiner or makes a decision about a person."
      },
      {
        "ja": "人事システムや勤怠の画面への登録はしない。",
        "en": "Does not enter anything in the HR or attendance systems."
      }
    ]
  },
  "onboarding": {
    "headline": {
      "ja": "入社する人の名前を伝えると、チェックリストと規程から準備のタスクを案にし、承認のあとに一件ずつタスク管理に登録する。",
      "en": "Name a new hire and it proposes the onboarding tasks from your checklist and policies, then creates each one in your task tracker once a person approves it."
    },
    "audience": {
      "ja": "新しいメンバーを迎える部署の上長、入社の準備を取りまとめる人事部の担当者",
      "en": "Managers welcoming a new team member, and the HR staff who coordinate onboarding"
    },
    "problem": {
      "ja": "入社が決まると、人事の担当者がチェックリストを見ながら、アカウント、PCや携帯電話、入館証と座席、研修の登録、初日の案内を、情報システム部や総務部、配属先の上長に一つずつ依頼している。部署や雇用形態によって用意するものが違い、依頼の漏れや期限の書き違いが起きやすい。",
      "en": "When someone is hired, an HR coordinator works through the checklist and asks IT, General Affairs and the hiring manager, one by one, for accounts, a laptop or phone, a badge and desk, training registration and the first-day welcome. What each person needs depends on their department and contract, so a request is easily missed or given the wrong due date."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：上長や人事の担当者から、チャットで入社する人の名前か社員番号を受け取る。",
          "en": "Receive: takes the new hire's name or employee number from a manager or HR in chat."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：人事データ、入社準備チェックリスト、アカウントと機器の規程、研修日程を照らし合わせる。",
          "en": "Look up: checks the HR records, the onboarding checklist, the account and equipment policies and the training schedule."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：チェックリストの項目ごとに、件名、担当、期限、備考と根拠の資料をそろえた案を作る。",
          "en": "Decide: drafts one task per checklist item, with its title, owner, due date, notes and the document it rests on."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：タスクを登録する前に、一件ごとに人の承認を待つ。",
          "en": "A person confirms: waits for a person's approval before creating each task."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認されたタスクだけを、タスク管理に登録する。",
          "en": "Write: creates only the approved tasks in your task tracker."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "チェックリストの項目ごとに、件名、担当、期限、備考、根拠の資料を並べたタスクの案",
        "en": "A proposal of tasks, one per checklist item, with the title, owner, due date, notes and source document"
      },
      {
        "ja": "案だけを求めたときの、型の決まったタスクの一覧（社員番号、氏名、入社日、タスク）",
        "en": "A typed task list when only a proposal is asked for (employee number, name, start date and the tasks)"
      },
      {
        "ja": "承認のあとタスク管理に登録される、担当者あての準備のタスク",
        "en": "Onboarding tasks for each owner, created in your task tracker once they are approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "自社のチェックリストや規程を使えますか？",
          "en": "Can it use our own checklist and policies?"
        },
        "a": {
          "ja": "チェックリスト、アカウントと機器の規程、研修日程は、自社のフォルダに置くファイルです。差し替えると、その内容でタスクを作ります。",
          "en": "The checklist, the account and equipment policies and the training schedule are files in your own folder. Replace them and it builds the tasks from what they say."
        }
      },
      {
        "q": {
          "ja": "入社する人を評価しますか？",
          "en": "Does it assess the new hire?"
        },
        "a": {
          "ja": "しません。適性や能力の評価、点数や順位は、求められても答えにもタスクにも書きません。人についての判断は人が行います。",
          "en": "No. It never rates a person's aptitude or ability, and writes no score or rank in its answer or in a task, even when asked. People make every decision about people."
        }
      },
      {
        "q": {
          "ja": "まとめて一度に登録できますか？",
          "en": "Can it create all the tasks at once?"
        },
        "a": {
          "ja": "できません。一回の承認で登録されるのは一件のタスクだけで、次のタスクはまた承認を待ちます。",
          "en": "No. One approval creates one task, and the next task waits for approval again."
        }
      }
    ],
    "limits": [
      {
        "ja": "入社する人の適性や能力を評価せず、順位や点数をつけない。",
        "en": "Never assesses, scores or ranks the new hire."
      },
      {
        "ja": "タスクは、人が一件ずつ承認するまで登録しない。",
        "en": "Creates no task until a person approves that task."
      },
      {
        "ja": "給与、採用の合否、勤怠の修正は扱わない。",
        "en": "Does not handle pay, hiring decisions or attendance corrections."
      },
      {
        "ja": "期限の日付を計算せず、人事データと研修日程に書かれた日付だけを使う。",
        "en": "Computes no due date; it uses only the dates in the HR records and the training schedule."
      }
    ]
  },
  "policy-qa": {
    "headline": {
      "ja": "社員からの社内規程についての質問に、規程の条文を示して答える。",
      "en": "Answers employees' questions about internal policies, citing the article each answer comes from."
    },
    "audience": {
      "ja": "人事総務部・経理部・情報システム部の担当者、規程を確かめたい社員",
      "en": "People in HR and general affairs, accounting and IT, and employees who want to check a rule"
    },
    "problem": {
      "ja": "就業規則、経費の規程、IT利用の規程について、同じような質問が社員から担当部署に繰り返し届いている。担当者はそのたびに規程集を開いて条文を探し、承認の要否や期限まで確かめてから返事をしている。",
      "en": "Employees keep sending the same questions about the work rules, the expense rules and the IT rules to the departments that own them. Each time, someone opens the policy library, finds the article, and checks whether an approval or a deadline applies before replying."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：社員から規程についての質問を受け取る。",
          "en": "Receive: takes an employee's question about a policy."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：質問した人が読める規程のフォルダだけを検索し、該当する条文を開いて読む。",
          "en": "Look up: searches only the policy folders the person asking may read, and opens the article that matches."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：条文に書かれた金額、期限、承認の条件をそのまま答えにまとめる。",
          "en": "Decide: puts the amounts, deadlines and approval conditions the article states into the answer, as written."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "あなたが確かめる：回答に付いた条文を開き、根拠を自分で確かめられる。規程にないことは推測せず、所管の部署を案内する。",
          "en": "You check the cited article: every answer names the article, so you can open it and check. It never guesses at what the policies do not say, and names the department to ask."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：何も書き込まない。条文の出典を付けた回答を、質問した人に返すだけである。",
          "en": "Write: writes nothing; it only returns the answer, with the article it comes from, to the person asking."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "結論と、その根拠を条文ごとに示した回答（規程名と条番号の出典つき）",
        "en": "An answer with the conclusion first and each fact backed by its article, citing the policy and the article number"
      },
      {
        "ja": "規程に記載がないときは、記載がないことと問い合わせ先を伝える回答",
        "en": "When the policies are silent, an answer that says so and names who to ask"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "自社の規程を使えますか？",
          "en": "Can it use our own policies?"
        },
        "a": {
          "ja": "規程は、自社のフォルダに置くファイルです。差し替えると、その内容から答えます。PDFやWordの規程も読めます。",
          "en": "The policies are files in your own folder. Replace them and it answers from what they say. It also reads policies saved as PDF or Word files."
        }
      },
      {
        "q": {
          "ja": "社員ごとに読める規程を分けられますか？",
          "en": "Can different employees see different policies?"
        },
        "a": {
          "ja": "はい。呼び出すアプリが質問ごとに、その人が読める規程のフォルダを範囲として渡すと、その範囲だけを検索します。管理職向けの規程を一般の社員の質問に使わない、といった分け方ができます。範囲を渡さないときは、エージェントに許可したすべての規程が対象です。",
          "en": "Yes, when the app that calls it passes the policy folders each person may read with every question: it then searches only those, so a policy meant for managers is not used to answer anyone else. Without that scope, it searches every policy the agent is granted."
        }
      },
      {
        "q": {
          "ja": "規程にない質問をされたらどうなりますか？",
          "en": "What happens when a question is not covered?"
        },
        "a": {
          "ja": "推測で答えず、規程に記載が見つからないことと、担当部署への問い合わせを案内します。",
          "en": "It does not guess. It says the policies do not cover the question and points to the department to ask."
        }
      }
    ],
    "limits": [
      {
        "ja": "規程に書かれていない決まりを作らず、法律の解釈や助言もしない。",
        "en": "Never makes up a rule the policies do not state, and gives no legal interpretation or advice."
      },
      {
        "ja": "休暇の申請、出張の予約、経費の精算などの手続きを代わりに行わない。",
        "en": "Does not apply for leave, book travel or file expenses on anyone's behalf."
      },
      {
        "ja": "規程の改定や例外の可否を判断しない。決めるのは担当部署である。",
        "en": "Does not decide on a policy change or an exception; the department that owns the policy does."
      }
    ]
  },
  "privacy": {
    "headline": {
      "ja": "サービスの設計メモを社内のチェックリストと照らし、項目ごとの記載と確認事項をまとめた個人情報影響評価の下書きを Word で作る。法的な判断はしない。",
      "en": "Drafts a privacy impact assessment as a Word document from a service's design memo, checking it against your checklist item by item and listing the points still to check. It gives no legal opinion."
    },
    "audience": {
      "ja": "新しいサービスやシステムを企画する担当者、個人情報の取り扱いを確認する法務・個人情報保護の担当者",
      "en": "People who plan new services or systems, and the legal and data protection staff who review how personal data is handled"
    },
    "problem": {
      "ja": "新しいサービスを出すたびに、設計メモを一行ずつ読んでチェックリストの項目に当てはめ、評価書を手で書き起こしている。利用目的がプライバシーポリシーの範囲に入っているか、保管期間や海外への委託が決まっているかを見落とすと、公開の直前に手戻りになる。",
      "en": "For every new service, someone reads the design memo line by line, maps it onto the checklist and writes the assessment by hand. Missing a purpose outside the privacy policy, an open-ended retention period or an undecided transfer abroad means rework just before launch."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：サービスの設計メモを受け取る。",
          "en": "Receive: takes the service's design memo."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：社内のチェックリストとプライバシーポリシーの抜粋を探して読む。",
          "en": "Look up: finds and reads your checklist and the privacy policy excerpt."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：チェックリストの項目ごとに、設計メモの記載と、決まっていない点や確認したいことを、根拠付きで回答に示す。法的な判断はしない。",
          "en": "Decide: shows in its reply, for each checklist item, what the memo says and what is undecided or still to check, with sources. It gives no legal opinion."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：Word のファイルを書き出す前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before writing the Word file."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された一回の書き出しで、評価書を Word のファイルにする。",
          "en": "Write: writes the assessment as a Word file in the one approved call."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "チェックリストの項目ごとの記載・状況・確認したいことを並べた評価書の構成（回答の中に表示）",
        "en": "An assessment outline in the reply: what the memo says for each checklist item, its status and what to check"
      },
      {
        "ja": "承認のあと書き出される、個人情報影響評価の Word ファイル（.docx）",
        "en": "The privacy impact assessment as a Word file (.docx), written once it is approved"
      },
      {
        "ja": "サービスの担当者と法務部に確かめたいことの一覧",
        "en": "A list of questions for the service owner and Legal"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "サービスが法律に違反していないかを判断しますか？",
          "en": "Does it decide whether the service breaks the law?"
        },
        "a": {
          "ja": "しません。適法かどうか、公開してよいかは、頼まれても答えません。評価書は設計メモの記載と確認事項を整理するもので、法令への適合は法務部が判断します。",
          "en": "No. It never says whether the service is lawful or may launch, even when asked. The assessment sets out what the memo says and what to check, and Legal decides whether the service complies."
        }
      },
      {
        "q": {
          "ja": "設計メモに個人のデータが載っていたらどうなりますか？",
          "en": "What if the design memo shows someone's personal data?"
        },
        "a": {
          "ja": "評価書には、氏名や電話番号などの値は書かず、「会員の氏名と電話番号」のようにデータの種類だけを書きます。",
          "en": "The assessment never copies values such as names or phone numbers; it names only the kind of data, such as \"member names and phone numbers\"."
        }
      },
      {
        "q": {
          "ja": "自社のチェックリストに合わせられますか？",
          "en": "Can it use our own checklist?"
        },
        "a": {
          "ja": "チェックリストとプライバシーポリシーは自社のフォルダに置くファイルです。差し替えると、その項目ごとに評価書を作ります。",
          "en": "The checklist and the privacy policy are files in your own folder. Replace them and it assesses against their items."
        }
      }
    ],
    "limits": [
      {
        "ja": "適法かどうか、公開してよいかを判断せず、法的助言もしない。判断は法務部が行う。",
        "en": "Never says whether a service is lawful or may launch, and gives no legal advice: Legal decides."
      },
      {
        "ja": "設計メモにない内容を書かず、個人のデータの値を評価書に写さない。",
        "en": "Never writes what the memo does not say, or copies a person's data into the assessment."
      },
      {
        "ja": "設計メモやチェックリストを書き換えない。",
        "en": "Never changes the design memo or the checklist."
      },
      {
        "ja": "委託先や本人に連絡したり、通知を送ったりしない。",
        "en": "Never contacts a provider or an individual, or sends a notice."
      }
    ]
  },
  "project-status": {
    "headline": {
      "ja": "毎週、タスク・マイルストーン・リスクの記録から、作業の流れごとに赤・黄・緑の状況を根拠付きでまとめる。",
      "en": "Each week, rates each workstream red, amber or green from the task, milestone and risk records, with the evidence."
    },
    "audience": {
      "ja": "プロジェクトマネージャー、週報を受け取るプロジェクトの責任者",
      "en": "Project managers, and project sponsors who receive the status report"
    },
    "problem": {
      "ja": "プロジェクトマネージャーは毎週、タスクの期日、マイルストーンの見込み、リスクの一覧を見比べて週報を書いている。状況の色づけが書く人の感覚に頼りがちで、遅れの兆しが週報に表れないことがある。",
      "en": "Each week a project manager compares task due dates, milestone forecasts and the risk list to write the status report. The colour given to each part of the work often rests on the writer's feel, and early signs of a delay may not show in the report."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：毎週決まった時刻に、週報を作る指示を受け取る。",
          "en": "Receive: takes the instruction to write the status report at a set time each week."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：プロジェクト管理ツールから書き出したタスク、マイルストーン、リスクの記録を、作業の流れごとに照らす。",
          "en": "Look up: matches the tasks, milestones and risks exported from the project tool, workstream by workstream."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：スキルに書いた基準で、作業の流れごとに赤・黄・緑を決め、根拠と残っているリスクをまとめる。",
          "en": "Decide: rates each workstream red, amber or green by the rules in its skill, with the evidence and the open risks."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：週報を保存する前に、担当者の承認を待つ。承認なしには保存しない。",
          "en": "A person confirms: waits for the owner's approval before saving the report, and never saves it without it."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された週報だけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved report to the reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "作業の流れごとの赤・黄・緑と、その根拠、残っているリスク",
        "en": "Each workstream's rating, with its evidence and open risks"
      },
      {
        "ja": "承認のあとフォルダに保存される、週報のMarkdownファイル",
        "en": "The status report as a Markdown file, saved to a folder once it is approved"
      },
      {
        "ja": "各行の出典（CSVのファイル名と行のID）",
        "en": "A source on every line: the CSV file name and the row id"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "どのデータを使いますか？",
          "en": "Which data does it use?"
        },
        "a": {
          "ja": "プロジェクト管理ツールから書き出したCSVファイル（タスク、マイルストーン、リスク）を自社のフォルダに置いて使います。デモでは架空のプロジェクトのデータを使っています。",
          "en": "CSV files exported from your project tool (tasks, milestones and risks), placed in your own folder. The demo uses data about a fictional project."
        }
      },
      {
        "q": {
          "ja": "赤・黄・緑の基準は変えられますか？",
          "en": "Can I change the rating rules?"
        },
        "a": {
          "ja": "変えられます。基準はスキルに書いてあり、スキルの説明を書き換えて変えます。",
          "en": "Yes. The rules are written in its skill, and you change them by editing the skill's description."
        }
      },
      {
        "q": {
          "ja": "計画やタスクを書き換えますか？",
          "en": "Does it change the plan or the tasks?"
        },
        "a": {
          "ja": "しません。週報を作って保存するまでで、計画の見直しは人が行います。",
          "en": "No. It writes and saves the report; a person revises the plan."
        }
      }
    ],
    "limits": [
      {
        "ja": "タスクや計画を書き換えない。",
        "en": "Never changes a task or the plan."
      },
      {
        "ja": "メンバーの働きぶりを評価しない。",
        "en": "Never judges a team member's performance."
      },
      {
        "ja": "記録にない日付や原因を推測しない。",
        "en": "Never guesses a date or a cause the records do not hold."
      },
      {
        "ja": "記録の中に書かれた指示には従わず、その内容として扱う。",
        "en": "Never follows an instruction written inside the records; it treats it as their content."
      }
    ]
  },
  "proposal": {
    "headline": {
      "ja": "打ち合わせメモと要件一覧から、自社の製品資料と導入事例をもとに、出典付きの提案書の構成を PowerPoint で作る。",
      "en": "Turns your meeting notes and the customer's requirements into a sourced proposal outline as a PowerPoint deck, built from your own product sheets and case studies."
    },
    "audience": {
      "ja": "法人営業の担当者、提案書の作成を支える営業企画の担当者",
      "en": "Account managers in B2B sales, and sales operations staff who help prepare proposals"
    },
    "problem": {
      "ja": "打ち合わせのあと、営業担当者がメモと要件を見返しながら、製品資料や過去の導入事例を探して提案書の骨子を組み立てている。どの資料にもとづく記述なのかが残らず、確認する人が出典を探し直すことも多い。",
      "en": "After a meeting, a salesperson goes back over the notes and requirements, hunts through product sheets and past case studies, and pieces together the outline of a proposal. Which document each statement came from is not recorded, so whoever checks the proposal often has to find the sources again."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：打ち合わせメモと、顧客の要件一覧を受け取る。",
          "en": "Receive: takes the meeting notes and the customer's requirements list."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：自社の製品資料・料金表・導入の進め方・導入事例から、要件に合うものを探す。",
          "en": "Look up: finds what meets the requirements in your product sheets, price list, rollout plan and case studies."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：表紙・課題・提案・導入計画・事例・費用・確認事項の構成を、出典の ID 付きで回答に示す。",
          "en": "Decide: shows the outline in its reply (title, problem, proposal, plan, cases, cost and open points), each point with the id of its source."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：PowerPoint のファイルを書き出す前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before writing the PowerPoint file."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された一回の書き出しで、提案書の構成を PowerPoint のファイルにする。",
          "en": "Write: writes the outline as a PowerPoint file in the one approved call."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "スライドごとのタイトルと箇条書きに、根拠にした要件・製品資料・事例の ID を添えた提案書の構成（回答の中に表示）",
        "en": "A proposal outline in the reply: each slide's title and bullets, with the id of the requirement, product sheet or case each one rests on"
      },
      {
        "ja": "承認のあと書き出される、提案書の構成の PowerPoint ファイル（.pptx）",
        "en": "The outline as a PowerPoint file (.pptx), written once it is approved"
      },
      {
        "ja": "メモにない台数や日付など、担当者が埋める確認事項の一覧",
        "en": "A list of open points for the salesperson to fill in, such as a quantity or a date the notes do not give"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "自社の製品資料や事例を使えますか？",
          "en": "Can it use our own product sheets and cases?"
        },
        "a": {
          "ja": "製品資料・料金表・導入事例は、自社のフォルダに置くファイルです。差し替えると、その内容から構成を作ります。",
          "en": "Product sheets, the price list and case studies are files in your own folder. Replace them and it builds the outline from what they say."
        }
      },
      {
        "q": {
          "ja": "資料にない実績や数字を書くことはありますか？",
          "en": "Will it write results or numbers our documents do not contain?"
        },
        "a": {
          "ja": "書きません。提案書に入れるのはメモと資料にあることだけで、足りないものは「要確認」として確認事項に挙げます。費用の合計も計算せず、単価と数量を並べるところまでです。",
          "en": "No. The deck holds only what is in the notes and the documents, and anything missing is listed as to be confirmed. It does not total the cost either: it lists the unit prices and the quantities."
        }
      },
      {
        "q": {
          "ja": "完成した提案書として、そのまま顧客に出せますか？",
          "en": "Can I send the deck to the customer as it is?"
        },
        "a": {
          "ja": "出せるのは下書きです。デザインや画像は入らず、内容と費用は担当者が確認してから仕上げます。顧客へファイルを送ることもしません。",
          "en": "It is a draft. It has no design or images, and a person checks the content and the cost before finishing it. It never sends a file to the customer."
        }
      }
    ],
    "limits": [
      {
        "ja": "顧客にファイルやメールを送らない。",
        "en": "Never sends a file or an email to the customer."
      },
      {
        "ja": "メモと資料にない製品・実績・数字・顧客名を書かない。",
        "en": "Never writes a product, a result, a number or a customer name that the notes and documents do not contain."
      },
      {
        "ja": "費用の合計や値引きを計算しない。",
        "en": "Does not total the cost or work out a discount."
      },
      {
        "ja": "スライドのデザイン・画像・グラフは作らない。",
        "en": "Does not design slides or add images or charts."
      }
    ]
  },
  "release-notes": {
    "headline": {
      "ja": "マージ済みのプルリクエストの一覧から、種類ごとにまとめた利用者向けのリリースノートの下書きを Word で作る。",
      "en": "Turns the export of merged pull requests into draft user-facing release notes, grouped by type, as a Word document."
    },
    "audience": {
      "ja": "ソフトウェアのプロダクト担当者、リリースを取りまとめる開発チームのリーダー",
      "en": "Software product managers, and development team leads who put each release together"
    },
    "problem": {
      "ja": "リリースのたびに、担当者がプルリクエストの一覧を見返し、利用者に関係する変更を拾って種類ごとに書き直している。開発向けの変更が紛れ込んだり、一覧にない効果を書き足したりしやすい。",
      "en": "At every release, someone goes back over the list of pull requests, picks out the changes that matter to users and rewrites them by type. Developer-only changes slip in, and effects the list never states get added."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：リリースに含まれるマージ済みプルリクエストの一覧を受け取る。",
          "en": "Receive: takes the export of the pull requests merged for the release."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：チームのリリースノートの書き方を読み、載せる変更と載せない変更を分ける。",
          "en": "Look up: reads your release notes style guide and separates what is listed from what is not."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：互換性・セキュリティ・新機能・不具合の修正の順に、プルリクエスト番号付きで構成を回答に示す。",
          "en": "Decide: shows the outline in its reply, compatibility, security, new features and bug fixes in that order, each item with its pull request number."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：Word のファイルを書き出す前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before writing the Word file."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された一回の書き出しで、リリースノートを Word のファイルにする。",
          "en": "Write: writes the release notes as a Word file in the one approved call."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "種類ごとの項目に、もとのプルリクエスト番号を添えたリリースノートの構成（回答の中に表示）",
        "en": "A release notes outline in the reply: the items of each group with the number of the pull request each comes from"
      },
      {
        "ja": "承認のあと書き出される、リリースノートの Word ファイル（.docx）",
        "en": "The release notes as a Word file (.docx), written once it is approved"
      },
      {
        "ja": "載せなかったプルリクエストとその理由、リリース日など担当者が埋める確認事項",
        "en": "The pull requests left out and why, and open points such as the release date"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "一覧にない変更を書くことはありますか？",
          "en": "Will it list changes the export does not contain?"
        },
        "a": {
          "ja": "書きません。載せるのは一覧にあるプルリクエストだけで、タイトルと説明に書かれていない効果や今後の予定は足しません。",
          "en": "No. It lists only the pull requests in the export, and adds no effect or plan that their titles and descriptions do not state."
        }
      },
      {
        "q": {
          "ja": "開発者向けの変更はどうなりますか？",
          "en": "What happens to developer-only changes?"
        },
        "a": {
          "ja": "書き方のルールで載せないとされたラベルの変更は、文書に入れず、載せなかった理由とともに回答で示します。",
          "en": "Changes whose label the style guide leaves out stay out of the document, and the reply lists them with the reason."
        }
      },
      {
        "q": {
          "ja": "自社の書き方に合わせられますか？",
          "en": "Can it follow our own style?"
        },
        "a": {
          "ja": "書き方のルールは自社のフォルダに置くファイルです。グループや順番を書き換えると、その内容に沿って構成を作ります。",
          "en": "The style guide is a file in your own folder. Change its groups or order and the outline follows it."
        }
      }
    ],
    "limits": [
      {
        "ja": "リリースノートを公開したり、利用者に送ったりしない。",
        "en": "Never publishes the release notes or sends them to users."
      },
      {
        "ja": "一覧にない変更・効果・予定を書かない。",
        "en": "Never lists a change, an effect or a plan that the export does not contain."
      },
      {
        "ja": "コードのレビューやマージはしない。",
        "en": "Does not review or merge code."
      },
      {
        "ja": "Markdown やウェブページの形では書き出さない。",
        "en": "Does not write Markdown or web pages."
      }
    ]
  },
  "returns": {
    "headline": {
      "ja": "返品の申込を返品規程と注文データに照らし、規程の項目ごとに判定と確認点を一覧にする。",
      "en": "Checks a return request against your return policy and the order record, with a verdict and what to confirm for each policy item."
    },
    "audience": {
      "ja": "ネットショップのカスタマーサポート担当者、返品の受付を取りまとめる店舗運営の担当者",
      "en": "Customer support staff at an online shop, and the people who run its returns"
    },
    "problem": {
      "ja": "返品の申込が届くと、サポートの担当者が注文管理システムで注文を探し、返品規程と見比べながら期限、商品の状態、返品できない商品かどうかを一つずつ確かめている。申込の書き方がまちまちで、確認の漏れが起きやすい。",
      "en": "When a return request arrives, someone on the support desk finds the order in the order system and checks the deadline, the condition of the item and whether it can be returned at all, one rule at a time against the return policy. Customers write requests in many ways, so a check is easy to miss."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：問い合わせフォームから書き出した返品の申込を受け取る。",
          "en": "Receive: takes a return request exported from the contact form."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：注文データから同じ注文番号の行を探し、返品規程の項目と照らす。",
          "en": "Look up: finds the order's rows in the order records and reads the return policy."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：規程の項目ごとに「OK・要確認・NG」の判定と、担当者が確認する点を付ける。",
          "en": "Decide: marks each policy item OK, caution or NG, with what the support desk should confirm."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：確認表を保存する前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before saving the review."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された確認表だけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved review to the returns-reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "返品規程の項目ごとに、申込と注文データの記載、判定、理由、確認する点を並べた表",
        "en": "A table with one row per policy item: what the request and the order record say, the verdict, the reason and what to confirm"
      },
      {
        "ja": "承認のあとレポート用のフォルダに保存される、Markdown形式の確認表",
        "en": "A review in Markdown, saved to the returns-reports folder once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "返金まで決めますか？",
          "en": "Does it decide the refund?"
        },
        "a": {
          "ja": "決めません。規程の項目ごとの判定までを示し、返品や返金を受け付けるかどうかは担当者が判断します。",
          "en": "No. It gives a verdict for each policy item; a person decides whether to accept the return and refund."
        }
      },
      {
        "q": {
          "ja": "自社の返品規程を使えますか？",
          "en": "Can it use our own return policy?"
        },
        "a": {
          "ja": "返品規程と注文データは、自社のフォルダに置くファイルです。差し替えると、その内容で判定します。",
          "en": "The return policy and the order records are files in your own folder. Replace them and it checks against what they say."
        }
      },
      {
        "q": {
          "ja": "お客様への返信も作りますか？",
          "en": "Does it write the reply to the customer?"
        },
        "a": {
          "ja": "作りません。お客様とのやり取りは担当者が行います。",
          "en": "No. A person handles the exchange with the customer."
        }
      }
    ],
    "limits": [
      {
        "ja": "返品、交換、返金を決めず、返金額も確定しない。",
        "en": "Never decides a return, an exchange or a refund, or its amount."
      },
      {
        "ja": "お客様にメッセージを送らず、返信の文面も作らない。",
        "en": "Never sends the customer a message or drafts a reply."
      },
      {
        "ja": "返品規程にない論点には、判定を付けない。",
        "en": "Gives no verdict on points the return policy does not cover."
      }
    ]
  },
  "screening-hr": {
    "headline": {
      "ja": "応募書類を募集要項の要件ごとに整理し、根拠になる記述を添えて一覧にする。順位や合否は付けない。",
      "en": "Summarizes each application against the posted requirements, with the applicant's own words as evidence. It never ranks or rejects anyone."
    },
    "audience": {
      "ja": "採用を担当する人事部の担当者、書類選考に加わる配属先の上長",
      "en": "Recruiters in HR, and hiring managers who take part in screening applications"
    },
    "problem": {
      "ja": "応募書類が届くと、採用の担当者が募集要項と見比べながら、要件ごとに経験や資格の記述を探している。書き方は応募者ごとに違い、どこに何が書かれているかを読み取るだけで手間がかかる。",
      "en": "When applications arrive, a recruiter reads each one beside the job posting and looks for the experience and certificates that speak to each requirement. Every applicant writes differently, so finding what is where takes time."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：採用管理システムから書き出した応募書類のファイルを受け取る。",
          "en": "Receive: takes an application exported from the applicant tracking system."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：募集要項の要件を、一つずつ応募書類の記述と照らす。",
          "en": "Look up: checks each posted requirement against what the application says."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：要件ごとに「満たす・不明確・記載なし」と、根拠になる記述の引用、確認したい点を並べる。",
          "en": "Decide: marks each requirement met, unclear or not shown, with a quote as evidence and what to confirm."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：サマリーを保存する前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before saving the summary."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認されたサマリーだけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved summary to the screening-hr-reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "募集要項の要件ごとに、判定、応募書類からの引用、理由、応募者に確認したい点を並べた表",
        "en": "A table with one row per posted requirement: the verdict, a quote from the application, the reason and what to ask the applicant"
      },
      {
        "ja": "承認のあとレポート用のフォルダに保存される、Markdown形式のサマリー",
        "en": "A summary in Markdown, saved to the screening-hr-reports folder once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "応募者に順位や点数を付けますか？",
          "en": "Does it rank or score applicants?"
        },
        "a": {
          "ja": "付けません。応募者どうしを比べることも、推薦や不採用の判断もしません。求められても断り、選考の判断は担当者が行います。",
          "en": "No. It never compares applicants, recommends one or rejects anyone. Asked to, it declines, and a person makes every hiring decision."
        }
      },
      {
        "q": {
          "ja": "年齢や性別は見ますか？",
          "en": "Does it look at age or gender?"
        },
        "a": {
          "ja": "要件にない個人の属性は、判定にもサマリーにも使いません。",
          "en": "It uses no personal attribute that a requirement does not name, in the verdicts or in the summary."
        }
      },
      {
        "q": {
          "ja": "自社の募集要項を使えますか？",
          "en": "Can it use our own job postings?"
        },
        "a": {
          "ja": "要件は、自社のフォルダに置くファイルです。募集ごとに差し替えると、その内容で整理します。",
          "en": "The requirements are files in your own folder. Replace them for each opening and it summarizes against what they say."
        }
      }
    ],
    "limits": [
      {
        "ja": "応募者に順位、点数、合否、推薦を付けず、選考の判断はすべて人が行う。",
        "en": "Never ranks, scores, recommends or rejects an applicant; a person makes every hiring decision."
      },
      {
        "ja": "応募者に連絡せず、通知のメールも作らない。",
        "en": "Never contacts an applicant or drafts a notice."
      },
      {
        "ja": "応募書類に書かれていない経験を推測しない。",
        "en": "Never infers experience the application does not state."
      }
    ]
  },
  "screening": {
    "headline": {
      "ja": "取引先の登録申請にある会社・役員・株主・最終需要者の名前を公開リストと照合し、一致の候補をリストの日付つきで担当者に示す。取引の可否は判断しない。",
      "en": "Checks every company and person in a counterparty registration request (the company, officers, shareholders and end user) against public lists, and flags possible matches for a person with the date of the lists. It never decides whether to do business."
    },
    "audience": {
      "ja": "新規の取引先を登録する調達・営業の担当者、取引先の確認を担う法務・輸出管理の担当者",
      "en": "Procurement and sales staff who register new counterparties, and the legal and export control staff who screen them"
    },
    "problem": {
      "ja": "新しい取引先を登録するたびに、申請書の名前を一つずつ公開リストで検索している。カタカナとローマ字の表記ゆれや、似た名前の別の会社を見落としやすく、どの日付のリストで確かめたかの記録も残りにくい。",
      "en": "For every new counterparty, someone searches the public lists by hand, one name of the request at a time. Variant spellings in katakana and romaji, or a similar name of a different company, are easy to miss, and which date of the lists was checked is rarely recorded."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：取引先の登録申請書を受け取る。",
          "en": "Receive: takes the counterparty registration request."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：社内の確認手順を読み、申請書のすべての名前を、表記を変えながら公開リストで検索する。",
          "en": "Look up: reads your screening procedure and searches the public lists for every name in the request, spelled several ways."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：手順の項目ごとに、一致なし・要確認・一致を、リストの記録と日付付きで回答に示す。取引の可否は判断しない。",
          "en": "Decide: shows in its reply no match, review or match for each item of the procedure, with the listed record and the date of the lists. It never decides whether to do business."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：報告書を保存する前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before saving the report."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された一回の保存で、照合の報告書を報告のフォルダに書く。",
          "en": "Write: saves the screening report to the reports folder in the one approved call."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "手順の項目ごとの照合結果と、該当したリストの記録・確認すべき点を並べた表（回答の中に表示）",
        "en": "A table in the reply: each item's result, the listed record found and what to confirm"
      },
      {
        "ja": "承認のあと保存される、照合したリストの日付つきの報告書（Markdown）",
        "en": "The screening report in Markdown, with the date of the lists checked, saved once it is approved"
      },
      {
        "ja": "項目ごとの型付きの照合結果",
        "en": "A typed result for each item"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "取引してよいかを判断しますか？",
          "en": "Does it decide whether we can do business with the party?"
        },
        "a": {
          "ja": "しません。取引してよいか、問題がないかは、頼まれても答えません。似た名前は別の相手だと決めつけず要確認として示し、判断は担当者が行います。",
          "en": "No. It never says whether to do business or that a party is cleared, even when asked. A similar name is flagged for review, never dismissed as someone else, and a person decides."
        }
      },
      {
        "q": {
          "ja": "どの時点のリストと照合しますか？",
          "en": "Which date of the lists does it check?"
        },
        "a": {
          "ja": "デモでは、架空の公開リストの日付つきスナップショット（2026-11-16 時点）と照合し、結果にその日付を示します。導入するときは、自社で使う公開リストの配布先を設定して、最新のリストを読みます。",
          "en": "The demo checks a dated snapshot of fictional public lists (as of 2026-11-16) and shows that date with every result. When you install it, you set the addresses of the public lists you use, and it reads the current lists."
        }
      },
      {
        "q": {
          "ja": "自社の確認手順に合わせられますか？",
          "en": "Can it use our own screening procedure?"
        },
        "a": {
          "ja": "確認手順は自社のフォルダに置くファイルです。差し替えると、その項目ごとに照合します。",
          "en": "The procedure is a file in your own folder. Replace it and it screens against its items."
        }
      }
    ],
    "limits": [
      {
        "ja": "取引してよいか、相手が安全かを判断せず、法的助言もしない。判断は担当者が行う。",
        "en": "Never says whether to do business or that a party is safe, and gives no legal advice: a person decides."
      },
      {
        "ja": "読んだリストとその日付の範囲を超えて「掲載なし」と言わない。",
        "en": "Never says a name is on no list beyond the lists and the date it read."
      },
      {
        "ja": "申請書や確認手順を書き換えない。",
        "en": "Never changes the request or the procedure."
      },
      {
        "ja": "取引先に連絡したり、個人の情報を調べたりしない。",
        "en": "Never contacts the counterparty or looks up someone's personal details."
      }
    ]
  },
  "sla-watch": {
    "headline": {
      "ja": "毎朝、SLAの期限を過ぎたチケットと期限が迫るチケットを、担当者と次の一手を添えて一覧にする。",
      "en": "Each morning, lists the tickets past or close to their SLA deadline, with the owner and a next step."
    },
    "audience": {
      "ja": "サポート窓口の担当者、チケットの期限を見守るサポートリーダー",
      "en": "Support agents, and support leads who watch ticket deadlines"
    },
    "problem": {
      "ja": "サポートリーダーは、ヘルプデスクの画面でチケットを一件ずつ開き、期限までの残り時間と担当者を確かめている。担当が決まっていないチケットや、回答待ちのまま止まっているチケットは、期限を過ぎてから気づくことがある。",
      "en": "A support lead opens tickets one by one in the helpdesk to check the time left and who owns each. A ticket with no owner, or one stuck waiting for an answer, can go unnoticed until its deadline has passed."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：毎朝決まった時刻に、レポートを作る指示を受け取る。",
          "en": "Receive: takes the instruction to write the report at a set time each morning."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：ヘルプデスクから書き出したチケットの一覧を読み、期限までの残り時間を確かめる。",
          "en": "Look up: reads the ticket list exported from the helpdesk and checks the time left before each deadline."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：スキルに書いた基準で、期限を過ぎたチケットと期限が迫るチケットを選び、担当者と次の一手をまとめる。",
          "en": "Decide: picks the tickets past or close to their deadline by the rules in its skill, with the owner and a next step."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：レポートを保存する前に、担当者の承認を待つ。承認なしには保存しない。",
          "en": "A person confirms: waits for the owner's approval before saving the report, and never saves it without it."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認されたレポートだけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved report to the reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "期限超過と期限間近に分けた、チケットごとの件名、優先度、残り時間、担当者、次の一手",
        "en": "Tickets split into past the deadline and close to it, each with its subject, priority, time left, owner and next step"
      },
      {
        "ja": "承認のあとフォルダに保存される、その日のレポートのMarkdownファイル",
        "en": "The day's report as a Markdown file, saved to a folder once it is approved"
      },
      {
        "ja": "各行の出典（CSVのファイル名とチケットのID）",
        "en": "A source on every line: the CSV file name and the ticket id"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "どのデータを使いますか？",
          "en": "Which data does it use?"
        },
        "a": {
          "ja": "ヘルプデスクから書き出したチケットの一覧（CSV）を自社のフォルダに置いて使います。デモでは架空の会社のデータを使っています。",
          "en": "A ticket list exported from your helpdesk as CSV, placed in your own folder. The demo uses data about fictional companies."
        }
      },
      {
        "q": {
          "ja": "「期限が迫る」の基準は変えられますか？",
          "en": "Can I change what counts as close to the deadline?"
        },
        "a": {
          "ja": "変えられます。期限までの残り時間の基準はスキルに書いてあり、スキルの説明を書き換えて変えます。",
          "en": "Yes. The rule for the time left is written in its skill, and you change it by editing the skill's description."
        }
      },
      {
        "q": {
          "ja": "顧客に返信したり、チケットを書き換えたりしますか？",
          "en": "Does it reply to customers or change tickets?"
        },
        "a": {
          "ja": "しません。レポートを作って保存するまでで、顧客への返信と担当の割り当ては人が行います。",
          "en": "No. It writes and saves the report; a person replies to the customer and assigns the tickets."
        }
      }
    ],
    "limits": [
      {
        "ja": "顧客に返信しない。",
        "en": "Never replies to a customer."
      },
      {
        "ja": "チケットの担当や状態を変えない。",
        "en": "Never changes a ticket's owner or status."
      },
      {
        "ja": "サポート担当者の成績を評価しない。",
        "en": "Never judges a support agent's performance."
      },
      {
        "ja": "チケットの中に書かれた指示には従わず、その内容として扱う。",
        "en": "Never follows an instruction written inside a ticket; it treats it as the ticket's content."
      }
    ]
  },
  "standup": {
    "headline": {
      "ja": "毎朝、前の営業日のタスク・コミット・チャットの記録から、人ごとに「昨日・今日・困りごと」をまとめる。",
      "en": "Each morning, sums up yesterday, today and blockers for each person from the previous working day's tasks, commits and chat."
    },
    "audience": {
      "ja": "開発チームのリーダー、朝会を進めるチームのメンバー",
      "en": "Development team leads, and team members who run the stand-up"
    },
    "problem": {
      "ja": "朝会の前に、リーダーがタスク管理ツール、コミットの履歴、チームのチャットを順に見て、誰が何を進めたかを拾い集めている。困りごとがチャットの中に埋もれて、朝会で取り上げられないままになることがある。",
      "en": "Before the stand-up, a team lead goes through the task tracker, the commit history and the team chat to piece together who moved what forward. Blockers mentioned in the chat can get buried and never come up at the stand-up."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：平日の毎朝決まった時刻に、まとめを作る指示を受け取る。",
          "en": "Receive: takes the instruction to write the digest at a set time each weekday morning."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：タスクの更新、コミット、チャットの書き出しから、前の営業日の記録を集める。",
          "en": "Look up: collects the previous working day's records from the task updates, commits and chat exports."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：人ごとに、昨日の作業、今日の予定、困りごとを出典付きでまとめる。人の評価はしない。",
          "en": "Decide: sums up each person's work yesterday, plans for today and blockers, each with its source, and never evaluates anyone."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：まとめを保存する前に、担当者の承認を待つ。承認なしには保存しない。",
          "en": "A person confirms: waits for the owner's approval before saving the digest, and never saves it without it."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認されたまとめだけを、レポート用のフォルダに保存する。",
          "en": "Write: saves only the approved digest to the reports folder."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "人ごとの昨日の作業、今日の予定、困りごと",
        "en": "For each person: yesterday's work, today's plans and blockers"
      },
      {
        "ja": "承認のあとフォルダに保存される、その日のまとめのMarkdownファイル",
        "en": "The day's digest as a Markdown file, saved to a folder once it is approved"
      },
      {
        "ja": "各行の出典（ファイル名とタスク、コミット、メッセージのID）",
        "en": "A source on every line: the file name and the task, commit or message id"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "どのデータを使いますか？",
          "en": "Which data does it use?"
        },
        "a": {
          "ja": "タスク管理ツールの更新履歴、コミットの履歴、チームのチャットを書き出したCSVファイルを自社のフォルダに置いて使います。デモでは架空のチームのデータを使っています。",
          "en": "CSV exports of your task tracker's update log, the commit history and the team chat, placed in your own folder. The demo uses data about a fictional team."
        }
      },
      {
        "q": {
          "ja": "メンバーの働きぶりを評価しますか？",
          "en": "Does it evaluate team members?"
        },
        "a": {
          "ja": "しません。まとめるのは作業の記録だけで、人を評価したり、比べたり、順位をつけたりはしません。頼まれても断ります。",
          "en": "No. It sums up work records only, and never rates, compares or ranks people. It declines when asked to."
        }
      },
      {
        "q": {
          "ja": "チャットに投稿しますか？",
          "en": "Does it post to the chat?"
        },
        "a": {
          "ja": "しません。まとめを作って保存するまでで、チームへの共有は人が行います。",
          "en": "No. It writes and saves the digest; a person shares it with the team."
        }
      }
    ],
    "limits": [
      {
        "ja": "人を評価したり、比べたり、順位をつけたりしない。",
        "en": "Never rates, compares or ranks people."
      },
      {
        "ja": "チャットに投稿せず、タスクを書き換えない。",
        "en": "Never posts to the chat or changes a task."
      },
      {
        "ja": "記録にない作業や予定を書き足さない。",
        "en": "Never adds work or plans the records do not hold."
      },
      {
        "ja": "記録の中に書かれた指示には従わない。",
        "en": "Never follows an instruction written inside the records."
      }
    ]
  },
  "translator": {
    "headline": {
      "ja": "社内文書を用語集に沿って日本語と英語の間で翻訳し、見出しと段落の構成を保った Word のファイルで返す。",
      "en": "Translates company documents between Japanese and English with your glossary, and returns a Word file that keeps the headings and paragraphs of the original."
    },
    "audience": {
      "ja": "社外向けの資料を二つの言語で出す広報・営業企画の担当者、海外の拠点とやり取りする部署",
      "en": "Public relations and sales planning staff who publish in two languages, and teams that work with overseas offices"
    },
    "problem": {
      "ja": "製品発表や社内通知を英語でも出すたびに、担当者が文書を訳し、製品名や社内の用語の訳し方を過去の資料で確かめている。訳した文章を元の文書の見出しや箇条書きに合わせて組み直す作業も手で行っている。",
      "en": "Each time a product announcement or a notice also goes out in English, someone translates it and checks past documents for how product names and company terms were translated. Fitting the translation back into the original's headings and bullets is done by hand too."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：翻訳する Word の文書か Markdown のファイルを受け取る。",
          "en": "Receive: takes the Word document or Markdown file to translate."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：同じ言語のフォルダにある訳語集と翻訳スタイルガイドを読む。",
          "en": "Look up: reads the glossary and the translation style guide in the folder of the same language."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：見出し、段落、箇条書きの順番と階層を保った訳文と、訳者メモを回答に示す。",
          "en": "Decide: shows the translation in its reply, keeping the order and levels of headings, paragraphs and bullets, with translator's notes."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：Word の文書を読むときと、訳文を書き出す前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval when it reads a Word document and before it writes the translation."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された一回の書き出しで、訳文を Word のファイルにする。",
          "en": "Write: writes the translation as a Word file in the one approved call."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "見出しと段落を原文と同じ順番で並べた訳文と、適用した訳語を挙げた訳者メモ（回答の中に表示）",
        "en": "The translation in the original's order of headings and paragraphs, with translator's notes listing the glossary terms applied, in the reply"
      },
      {
        "ja": "承認のあと書き出される、訳文の Word ファイル（.docx）",
        "en": "The translation as a Word file (.docx), written once it is approved"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "自社の用語集を使えますか？",
          "en": "Can it use our own glossary?"
        },
        "a": {
          "ja": "訳語集と翻訳スタイルガイドは、自社のフォルダに置くファイルです。差し替えると、その訳語で翻訳します。",
          "en": "The glossary and the style guide are files in your own folder. Replace them and it translates with your terms."
        }
      },
      {
        "q": {
          "ja": "PowerPoint や PDF も翻訳できますか？",
          "en": "Can it translate PowerPoint or PDF files?"
        },
        "a": {
          "ja": "いまは Word の文書と Markdown のファイルだけです。PowerPoint、Excel、PDF の翻訳には対応していません。",
          "en": "Not yet: it translates Word documents and Markdown files only. PowerPoint, Excel and PDF are not supported."
        }
      },
      {
        "q": {
          "ja": "書式やレイアウトもそのまま残りますか？",
          "en": "Does it keep the formatting and layout?"
        },
        "a": {
          "ja": "残るのは見出し、段落、箇条書きの構成です。色、フォント、画像、表の体裁は引き継がれません。",
          "en": "It keeps the structure of headings, paragraphs and bullets. Colours, fonts, images and table layout are not carried over."
        }
      }
    ],
    "limits": [
      {
        "ja": "日本語と英語の間だけを翻訳する。",
        "en": "Translates between Japanese and English only."
      },
      {
        "ja": "PowerPoint、Excel、PDF の文書は翻訳しない。",
        "en": "Does not translate PowerPoint, Excel or PDF documents."
      },
      {
        "ja": "色、フォント、画像、表の体裁は引き継がない。",
        "en": "Does not carry over colours, fonts, images or table layout."
      },
      {
        "ja": "原文にない説明や宣伝の言葉を足さない。",
        "en": "Never adds an explanation or promotional wording the original does not have."
      }
    ]
  },
  "work-instruction": {
    "headline": {
      "ja": "現場での口頭説明の文字起こしから、安全基準の条項を添えた作業手順書の下書きを Word で作る。",
      "en": "Turns a transcript of a spoken walkthrough on the floor into a draft work instruction as a Word document, with safety notes cited from your safety standard."
    },
    "audience": {
      "ja": "製造現場の班長・監督者、作業標準を整える生産技術の担当者",
      "en": "Team leaders and supervisors on the shop floor, and production engineers who keep work standards up to date"
    },
    "problem": {
      "ja": "作業手順書は、ベテランの説明を聞き取った担当者が、メモを見返しながら書き起こしている。安全上の注意は安全基準と照らし合わせて書き足す必要があり、説明で触れなかった保護具や確認が抜けやすい。",
      "en": "A work instruction is written by someone who listened to an experienced operator and goes back over their notes. The safety notes have to be checked against the safety standard and added by hand, and protective gear or checks the operator did not mention are easily missed."
    },
    "steps": [
      {
        "text": {
          "ja": "受け取る：現場での説明を文字起こししたテキストを受け取る。",
          "en": "Receive: takes the transcript of a walkthrough on the floor."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "調べる：安全基準と設備の取扱説明書から、手順に関わる条項を探す。",
          "en": "Look up: finds the clauses of the safety standard and the machine manual that apply to the steps."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "判断する：手順と安全上の注意を、文字起こしの時刻や条項の番号付きで回答に示す。",
          "en": "Decide: shows the steps and safety notes in its reply, each with its transcript time or clause number."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "人が確認する：Word のファイルを書き出す前に、担当者の承認を待つ。",
          "en": "A person confirms: waits for approval before writing the Word file."
        },
        "safety": []
      },
      {
        "text": {
          "ja": "書き込む：承認された一回の書き出しで、作業手順書を Word のファイルにする。",
          "en": "Write: writes the work instruction as a Word file in the one approved call."
        },
        "safety": []
      }
    ],
    "outputs": [
      {
        "ja": "見出しごとの要点に、文字起こしの時刻や安全基準・取扱説明書の条項を添えた作業手順書の構成（回答の中に表示）",
        "en": "A work instruction outline in the reply: each heading's points with the transcript time or the clause of the safety standard or manual they rest on"
      },
      {
        "ja": "承認のあと書き出される、作業手順書の Word ファイル（.docx）",
        "en": "The work instruction as a Word file (.docx), written once it is approved"
      },
      {
        "ja": "聞き取れなかった箇所など、監督者が確かめる確認事項の一覧",
        "en": "A list of open points for the supervisor, such as a passage the transcription could not make out"
      }
    ],
    "faq": [
      {
        "q": {
          "ja": "いつ使えるようになりますか？",
          "en": "When can I use it?"
        },
        "a": {
          "ja": "まだ公開前です。公開のお知らせに登録すると、公開したときにメールでお知らせします。",
          "en": "It is not live yet. Sign up for a launch notice and we will email you when it opens."
        }
      },
      {
        "q": {
          "ja": "文字起こしはどこから来ますか？",
          "en": "Where does the transcript come from?"
        },
        "a": {
          "ja": "プラットフォームの文字起こし機能が録音から作ったテキストを使います。デモでは、架空の説明の文字起こしを使います。文字起こしは聞き違えることがあるため、聞き取れなかった箇所は推測せず「要確認」にします。",
          "en": "It uses the text the platform's transcription makes from a recording. The demo uses a fictional transcript. A transcription can mishear, so a passage it could not make out is never guessed: it is marked to be confirmed."
        }
      },
      {
        "q": {
          "ja": "説明で触れなかった安全上の注意はどうなりますか？",
          "en": "What about safety notes the operator did not mention?"
        },
        "a": {
          "ja": "安全基準にある条項は、説明で触れていなくても、その条項の番号とともに手順書に加えます。逆に、文字起こしや資料にない手順や数値は書きません。",
          "en": "A clause of the safety standard that applies is added with its number, even when the walkthrough skipped it. A step or a value that is not in the transcript or the documents is never written."
        }
      },
      {
        "q": {
          "ja": "写真や図は入りますか？",
          "en": "Does it add photos or drawings?"
        },
        "a": {
          "ja": "入りません。見出し・文章・番号付きの手順・表だけの文書です。写真や図は、担当者が仕上げのときに加えます。",
          "en": "No. The document holds headings, text, numbered steps and tables only. A person adds photos or drawings when finishing it."
        }
      }
    ],
    "limits": [
      {
        "ja": "写真・図・書式の凝ったレイアウトは作らない。",
        "en": "Does not add photos, drawings or styled layouts."
      },
      {
        "ja": "文字起こしと資料にない手順や数値を書かない。",
        "en": "Never writes a step or a value that the transcript and documents do not contain."
      },
      {
        "ja": "手順書を発行したり、作業者に配ったりしない。",
        "en": "Does not issue the instruction or hand it out to workers."
      },
      {
        "ja": "作業者の評価はしない。",
        "en": "Does not assess any worker."
      }
    ]
  }
});
