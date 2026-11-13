---
changelog: platform
section: Changed
---

- The run screen a chat becomes is in Japanese for a Japanese reader: the status badge
  (承認待ち and the others), the follow-up box and its placeholder, Send, the line before Send
  and the agent's detail line (標準サンドボックス · 読み書き), the working and failure notices,
  and Show technical details with its tabs. Each part carries `lang`, so a screen reader reads it as
  Japanese. The transcript, activity lines and event log are shown as they arrive.
- The approval card shows a shell command on its own, so the person deciding reads the command, not
  the call's JSON. The full call, with the agent's own description of the command, is one click away
  under "Full call" (呼び出しの全文). A call with any other argument, and any other tool, is shown in
  full.
