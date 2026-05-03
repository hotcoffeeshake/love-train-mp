import { describe, expect, it } from 'vitest';
import { generateInviteCode, isValidInviteCode } from '../../src/utils/invite-code.js';

describe('invite-code', () => {
  it('generates a 6-character code from the safe alphabet', () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it('generates distinct codes across many samples', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) codes.add(generateInviteCode());
    // 32^6 ≈ 1.07B; in 10k samples expect zero or near-zero collisions
    expect(codes.size).toBeGreaterThan(9990);
  });

  it('isValidInviteCode accepts good shape and rejects bad', () => {
    expect(isValidInviteCode('A8K2P9')).toBe(true);
    expect(isValidInviteCode('a8k2p9')).toBe(false); // lowercase
    expect(isValidInviteCode('A8K2P')).toBe(false);  // too short
    expect(isValidInviteCode('A8K2P90')).toBe(false); // too long
    expect(isValidInviteCode('A8K2P0')).toBe(false); // contains 0 (excluded)
    expect(isValidInviteCode('A8K2PI')).toBe(false); // contains I (excluded)
    expect(isValidInviteCode('')).toBe(false);
  });
});
