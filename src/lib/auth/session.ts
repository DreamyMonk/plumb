// Password sessions. Web Crypto only, so this runs in the proxy as well as in routes.

export const SESSION_COOKIE = "plumb_session";
export const SESSION_DAYS = 30;
const DAY_MS = 86_400_000;

const encoder = new TextEncoder();

function toBase64Url(bytes: ArrayBuffer): string {
  let text = "";
  for (const byte of new Uint8Array(bytes)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(new ArrayBuffer(raw.length));
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** The signing key comes from the password, so changing the password ends every session. */
function signingKey(password: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(`plumb-session:${password}`), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** A session is its expiry time plus a signature over it. Nothing secret is inside. */
export async function createSession(password: string, now = Date.now()): Promise<string> {
  const expires = String(now + SESSION_DAYS * DAY_MS);
  const signature = await crypto.subtle.sign("HMAC", await signingKey(password), encoder.encode(expires));
  return `${expires}.${toBase64Url(signature)}`;
}

export async function verifySession(token: string | undefined, password: string, now = Date.now()): Promise<boolean> {
  if (!token) return false;
  const [expires, signature] = token.split(".");
  if (!expires || !signature || !/^\d+$/.test(expires) || Number(expires) <= now) return false;
  const bytes = fromBase64Url(signature);
  if (!bytes) return false;
  // verify() compares in constant time.
  return crypto.subtle.verify("HMAC", await signingKey(password), bytes, encoder.encode(expires));
}

/** Compares fixed-length digests in constant time, so response timing reveals nothing. */
export async function passwordMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([given, expected].map((text) => crypto.subtle.digest("SHA-256", encoder.encode(text))));
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

export const MIN_PASSWORD_LENGTH = 8;

/** Where to go after logging in. Only paths on this site, so a link can't bounce elsewhere. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\") || next.startsWith("/login")) return "/";
  return next;
}
