export const MAX_SESSION_IDENTIFIER_LENGTH = 256;

export function normalizeSessionIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_IDENTIFIER_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

export function encodeSessionKeyPart(value: string): string {
  return value.replaceAll('%', '%25').replaceAll('|', '%7C');
}
