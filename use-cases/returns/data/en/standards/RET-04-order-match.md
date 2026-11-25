# RET-04 Match with the order

- Source: returns and exchanges policy, section 5
- Standard: the order number, item and quantity on the request form match a row of the order record.

## Verdict

- OK: there is a row for the order number, and its item and quantity match the request form.
- Caution: there is a row for the order number, but the item or the quantity does not match the request form.
- NG: the order record has no row for the order number on the request form.
