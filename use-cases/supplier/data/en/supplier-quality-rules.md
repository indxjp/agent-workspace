# Supplier quality rules

Use the incoming inspection defect rate the quality system computed, `defect_ppm`. Never compute it
again yourself.

## When a supplier is on watch

A supplier is on **watch** when any one of these holds. Give every condition that holds as a reason.

1. **Over the limit**: its defect rate in the month reported is over 500 ppm.
2. **Worse three months running**: in each of the three months up to the month reported, its
   defect rate is higher than in the month before (for a November report: September higher than
   August, October higher than September, and November higher than October).
3. **Open claim**: the claims list holds a claim of the supplier whose `status` is `open`.

A supplier for which none holds is **ok**. A month over the limit in the past does not make it
watch if none holds in the month reported; that month may be mentioned as a note.

## What the report never does

- It never contacts a supplier, issues a corrective action request, or decides to stop business or
  change orders. The quality assurance staff decide.
- It never guesses the cause of a defect: it writes only what the claim's description says.
