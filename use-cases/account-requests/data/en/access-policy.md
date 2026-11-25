# Access grant policy (Aogiri Trading Co., Ltd., fictional)

There are three levels: `read`, `write` (create and update) and `admin` (settings and user management). A person's role is the "Role" column of the HR records (`employees.csv`).

## ACC-01 CRM

- Sales reps and sales managers: up to `write`.
- People in other departments: up to `read`.

## ACC-02 Expense system

- Everyone: `read`.
- Accountants and accounting managers: up to `write`.

## ACC-03 Accounting system

- People in Accounting (accountants and accounting managers): up to `write`.
- People in other departments: none.

## ACC-04 Admin access

- `admin` is granted only to people whose role is "System administrator". A grant to anyone else is not handled by a request under this policy; it is an exception request to the head of IT.

## ACC-05 Time-limited access

- Access granted to agency or fixed-term staff carries the "Contract end" date of the HR records as its end date (until).

## ACC-06 One grant at a time

- Each change, one level on one system, is one record, created after a person approves it.
