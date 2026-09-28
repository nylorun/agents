/**
 * A stand-in for your app's sign-in: the person is whoever the `demo_user` cookie names.
 * Replace it with your session lookup. Return a stable, namespaced id (`app:<user id>`),
 * never an email address; `undefined` answers 401.
 */
export function userFromCookie(request: Request): { id: string } | undefined {
  const cookies = request.headers.get("cookie") ?? "";
  const match = /(?:^|;\s*)demo_user=([A-Za-z0-9_-]{1,64})(?:;|$)/.exec(cookies);
  return match ? { id: `app:${match[1]}` } : undefined;
}
