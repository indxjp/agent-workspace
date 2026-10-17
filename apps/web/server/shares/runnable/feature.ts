/** D-06 excludes runnable public links from this release. */
export function runnablePublicLinksEnabled(
  _env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  void _env;
  // Usage settlement is durably attributed to a share, but admission still cannot reserve the
  // unknown cost of a run before it starts and the output-visibility boundary is incomplete. An
  // environment switch cannot safely opt a deployment into that incomplete security model, so
  // the release gate remains deliberately constant.
  return false;
}
