/**
 * ULID-style order IDs: 48-bit timestamp + 80-bit randomness,
 * encoded in Crockford base32 (26 chars, lexicographically sortable).
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encode(value: bigint, length: number): string {
  let out = '';
  let v = value;
  for (let i = 0; i < length; i++) {
    out = ALPHABET[Number(v & 31n)] + out;
    v >>= 5n;
  }
  return out;
}

export function newOrderId(): string {
  const time = encode(BigInt(Date.now()), 12);
  const randomBytes = crypto.getRandomValues(new Uint8Array(10));
  let random = 0n;
  for (const byte of randomBytes) random = (random << 8n) | BigInt(byte);
  return time + encode(random, 16);
}

/**
 * Constant-time string comparison for webhook secret validation.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
