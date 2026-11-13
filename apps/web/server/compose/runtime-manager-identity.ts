import { fetchCloudRunIdentityToken } from '@agent-workspace/runtime/driver/cloud-run';

export function withRunnerManagerIdentity(
  doFetch: typeof globalThis.fetch,
  audience: string,
  mintToken: (audience: string) => Promise<string> = fetchCloudRunIdentityToken,
): typeof globalThis.fetch {
  const origin = new URL(audience).origin;
  return async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (new URL(url, origin).origin !== origin) return doFetch(input, init);
    let token: string;
    try {
      token = await mintToken(audience);
    } catch (error) {
      throw new Error(
        `runner manager identity token could not be minted for audience ${audience}`,
        {
          cause: error,
        },
      );
    }
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    headers.set('X-Serverless-Authorization', `Bearer ${token}`);
    return doFetch(input, { ...init, headers });
  };
}
