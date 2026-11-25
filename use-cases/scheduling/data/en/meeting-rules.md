# Internal meeting scheduling rules (Misago Sekkei, fictional)

General Affairs' rules for putting an internal meeting on the company calendar. The staff are in `members.csv`, and each person's schedule (free or busy only) is in `busy.csv`, exported from the scheduling system.

## SCH-01 Meeting slots

- A meeting takes one hour-long slot starting at 10:00, 11:00, 13:00, 14:00, 15:00 or 16:00 on a weekday.
- A meeting longer than an hour, or at a time that fits no slot, is not scheduled this way: the organizer puts it in the calendar directly.

## SCH-02 Free slots

- A slot is free only when, for every attendee, neither `busy.csv` nor the events put on the calendar (the calendar's list) hold anything that overlaps it.

## SCH-03 Candidates and the event

- Show up to three free slots in the requested period as candidates, earliest first.
- Put the earliest candidate on the calendar. To take another candidate, the organizer rejects the event and names the slot.
- When the period has no free slot, put nothing on the calendar and say there is none.

## SCH-04 Attendees

- Attendees are written as the names of staff listed in `members.csv` only. Never write an email address.
- Never add a person from outside the company. The organizer contacts outside people separately.

## SCH-05 Location

- The location is "Online". When a room is needed, it is booked separately through facility booking.

## SCH-06 Invitations

- The event is only put on the company calendar. No invitation email is sent.
