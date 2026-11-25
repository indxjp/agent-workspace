# Investigation playbooks (first steps)

The first steps from the playbooks of the security monitoring team (SOC) of Sasame Electric, a
fictional company. Isolating a device or disabling an account is decided and done by the analyst.

## PB-MAL-01 Suspicious program execution

1. In the EDR console, check the parent process, the command line and what the device did just
   before and after.
2. Check whether other devices also talk to the remote address.
3. Find the file and the email it came from, and list everyone who received the same email.
4. The analyst decides with the SOC lead whether to isolate the device.

## PB-AUTH-01 Many failed sign-ins

1. Compare the source address with `known-addresses.csv`.
2. Check whether any of the user names that failed also signed in successfully.
3. When attacks from an unknown source go on, the analyst decides whether to block it.

## PB-ID-02 Impossible travel or a suspicious sign-in

1. Check the source and device of both sign-ins and the multi-factor result.
2. Ask the person, through another channel such as a phone call, whether they signed in at that
   time.
3. For an administrator account, tell the SOC lead; the analyst decides whether to revoke the
   sessions.

## PB-PHISH-01 A reported suspicious email

1. Check the sender's domain and where the link goes.
2. Check who else received the same email and whether anyone opened the link.
3. If someone opened it, check their account with PB-ID-02.
