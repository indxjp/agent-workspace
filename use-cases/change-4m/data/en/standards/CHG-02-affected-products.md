---
id: CHG-02
title: Affected products
---

(A sample of the 4M change control rules of a fictional company, Onaga Jushi Kogyo Co., Ltd.)

## Rule

Compare the "affected products" on the request with the products that use the changed item's code in the parts usage list.

- OK: every product of the list is on the request.
- caution: the changed item's code is not in the parts usage list.
- NG: a product of the list is not on the request.

## Action

For NG, add the missing products to the request and check their process and customer. For caution, confirm the code with production engineering.
