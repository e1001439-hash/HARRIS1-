import { createHmac, timingSafeEqual } from 'node:crypto';
export function validSignature(body: Buffer, signature: unknown, secret: string): boolean {
  if (typeof signature !== 'string') return false;
  const expected = createHmac('sha256', secret).update(body).digest('base64');
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}
