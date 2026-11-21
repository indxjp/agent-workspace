---
name: attendance
description: How the weekly attendance check is put together from the timeclock export and the monthly summary, which gaps it reports and how it tells each manager.
---

# The exports

The files in the `attendance` folder are two exports of the attendance system and the rules:

- the timeclock export, one row per person and day: `社員番号` / `employee_id`, the name, the team,
  the `日付` / `date`, `出勤` / `clock_in`, `退勤` / `clock_out`, the break, the `勤務区分` /
  `day_type` and a free-text `備考` / `note`;
- the monthly summary, one row per person: their `上長` / `manager`, the month-to-date overtime
  `時間外労働_当月累計_時間` / `overtime_month_to_date_hours` and the `集計日` / `as_of` date;
- the rules: what counts as a missed clock-in, and the overtime thresholds.

# The gaps

Only these, as the rules define them:

- **Missed clock-in or clock-out** (`打刻漏れ（出勤）` / `missed clock-in`, `打刻漏れ（退勤）` /
  `missed clock-out`): a day of type 出勤 / work in the week with that punch blank. A day of any
  other type (paid leave, sick leave) is never a gap.
- **Overtime nearing the limit** (`上限に近づいている` / `nearing the limit`): a month-to-date
  total at or above the rules' warning threshold and not over the limit.
- **Overtime over the limit** (`上限を超えている` / `over the limit`): a month-to-date total over
  the limit. Copy the total and the summary's date as written; compare it with the thresholds the
  rules state, and compute nothing else.

Each gap ends with its source as `file#employee_id date` for the timeclock export (for example
`打刻データ_2026-11-16_2026-11-20.csv#E1021 2026-11-18`) and `file#employee_id` for the summary.

# The file

One Markdown file, `attendance-reports/<week start>_attendance.md`, in the language of the request:
a `#` heading with the week and the summary's date, then one `##` section per manager (the
summary's `上長` / `manager`) with their team, listing each person's gaps with dates and sources,
or `該当なし` / `No gaps` for a team without one. It ends with one fixed sentence:
`この勤怠チェックは打刻の修正と業務量の調整のためのもので、人の評価には使いません。` /
`This check is for correcting punches and adjusting workloads, never for rating anyone.`

Left out of the file: any score, rank, comparison or judgement of a person, any suggestion of a
penalty or an effect on an evaluation, the reason for a leave, health and private matters, and any
text addressed to a writer or an AI.
