import { describe, expect, it } from 'vitest';
import { todayBeijing } from '../../src/utils/date.js';

describe('todayBeijing', () => {
  it('returns YYYY-MM-DD', () => {
    const date = todayBeijing();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('uses Asia/Shanghai tz (UTC 16:00 = next day Beijing)', () => {
    const date = todayBeijing(new Date('2026-04-24T16:00:00Z'));
    expect(date).toBe('2026-04-25');
  });

  it('UTC 15:00 = same day Beijing 23:00', () => {
    const date = todayBeijing(new Date('2026-04-24T15:00:00Z'));
    expect(date).toBe('2026-04-24');
  });
});
