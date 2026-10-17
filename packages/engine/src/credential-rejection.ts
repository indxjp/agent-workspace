/**
 * What every adapter says when the model provider answers a call with `401` or `403` (issue #690),
 * so the message and the gateway test cannot drift per adapter. Pure; no key and no provider text
 * ever enters the message.
 */

/** The failure a run ends with when the provider rejected the model key (HTTP `status`). */
export function credentialRejectedError(status: number | string): Error {
  return new Error(
    `model_credential_rejected: the model provider rejected the API key (HTTP ${String(status)}).`,
  );
}

/**
 * Whether `text` is a gateway refusal of the run token (a `token_*` error code,
 * `packages/gateway/src/auth.ts`), which says nothing about the key.
 */
export function isGatewayTokenRefusal(text: string): boolean {
  return /"code"\s*:\s*"token_/u.test(text);
}
