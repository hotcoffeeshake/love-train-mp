import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars; excludes 0/O/1/I (L kept — not commonly confused)
const LEN = 6;

export function generateInviteCode(): string {
  const bytes = randomBytes(LEN);
  let out = '';
  for (let i = 0; i < LEN; i += 1) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

const PATTERN = new RegExp(`^[${ALPHABET}]{${LEN}}$`);

export function isValidInviteCode(code: string): boolean {
  return typeof code === 'string' && PATTERN.test(code);
}
