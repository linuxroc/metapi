import { createHash, timingSafeEqual } from 'node:crypto';

function digestToken(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function secureTokenEqual(candidate: unknown, expected: unknown): boolean {
  const candidateText = typeof candidate === 'string' ? candidate : '';
  const expectedText = typeof expected === 'string' ? expected : '';
  if (!expectedText) return false;
  return timingSafeEqual(digestToken(candidateText), digestToken(expectedText));
}
