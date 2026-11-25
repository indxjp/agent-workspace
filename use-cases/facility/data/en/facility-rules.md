# Facility booking rules (Yamagara Seiko, fictional)

General Affairs' rules for booking meeting rooms and pool cars. The resources are in `resources.csv`, the current bookings in `bookings.csv` (exported from the booking system), and the people allowed to drive a pool car in `drivers.csv`.

## FAC-01 Booking times

- A booking falls within the resource's bookable hours, in steps of 30 minutes.
- One meeting room booking lasts at most 4 hours. A pool car is booked for at most one day (08:00 to 20:00).

## FAC-02 Capacity

- When more people will use it than the resource's capacity, do not book it. Propose a resource of the same type with enough capacity.

## FAC-03 Who a pool car is booked for

- Book a pool car only for a person listed in `drivers.csv` with a driving permit "Yes", on a day no later than the permit's end date.
- Never book one for a person who is not listed or whose permit has expired. Tell them to apply for a driving permit at General Affairs.

## FAC-04 The board room

- The head office 5F board room (RM-03) needs the head of General Affairs' approval, so it is never booked from chat. Tell the person to apply to General Affairs.

## FAC-05 Overlaps

- When `bookings.csv` or the bookings made in chat (the booking system's list) hold a booking of the same resource whose time overlaps, do not book that resource.
- Propose a resource of the same type with enough capacity that is free at that time. When there is none, say that no resource is free.

## FAC-06 What a booking holds

- One booking is one resource for one time span. It is booked for the person who uses it, and always states its purpose.
- An existing booking is never changed or cancelled in chat: the person who booked it does that in the booking system.
