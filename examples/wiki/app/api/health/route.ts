// Liveness only: it never reads the app's configuration, so an app that is not connected yet
// still answers 200 here while its API answers app_misconfigured.
export function GET(): Response {
  return new Response('ok', { headers: { 'cache-control': 'no-store' } });
}
