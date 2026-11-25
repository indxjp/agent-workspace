---
id: CHG-04
title: Customer notice
---

(A sample of the 4M change control rules of a fictional company, Onaga Jushi Kogyo Co., Ltd.)

## Rule

Look for products using the changed item's code whose "customer notice" in the parts usage list is "required".

- OK: no product is "required"; or one is, and the request gives the date the customer will be told.
- NG: a product is "required", but the request gives no notice date, or says no notice is needed.

## Action

For NG, set the notice date for the customer of each "required" product through sales, and add it to the request. Do not switch over before the customer is told.
