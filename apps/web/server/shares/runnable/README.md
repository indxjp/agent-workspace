# Runnable-share visitor identity

Runnable public links remain disabled by the D-06 release gate. Before a future release enables
them, every public-message request must arrive through a trusted reverse-proxy chain and set
`AW_TRUSTED_PROXY_HOPS` to the exact number of proxies that append `X-Forwarded-For`.

The application selects the client address from the right edge of that chain. It does not trust
the leftmost value, fall back to `User-Agent`, or accept an unconfigured direct connection because
a Fetch `Request` does not expose its socket peer. The web service must therefore be unreachable
except through the declared proxies. Proxies must overwrite or append `X-Forwarded-For`; a proxy
that passes the header through unchanged is not trusted.

Only a versioned HMAC of the canonical client address is persisted. Raw client addresses are not
stored in `share_views`. Rotating `SESSION_SECRET` intentionally changes these opaque visitor keys
and therefore resets their rolling rate-limit identity and ephemeral public session identity.

Atomic visitor reservation and the `share_run_charges` ledger protect the dormant implementation
across web replicas. A public run is linked before launch; provider settlement advances the run,
link, and share totals in one transaction, with the provider response id as the retry key. This
provides durable cost attribution but does not reserve an unknown maximum cost for concurrent
in-flight runs. D-06 must stay closed until strict in-flight budget reservation and the public
output-visibility boundary are implemented and tested.
