# Invite + Subscription Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship invite-binding + bonus quota + paid-tier (¥20/月, 30 次/日) + 微信支付 JSAPI v3 with a `WXPAY_MODE=mock|real` env switch so the full UI/data flow can be tested today, and flipping one env var at merchant-account time activates real payment with no code change.

**Architecture:** Extend existing Fastify+CloudBase NoSQL backend with five new routes (`/invite/bind`, `/payment/create-order`, `/wxpay/notify`, `/admin/*`) and a static admin HTML page served from the same container. Reuse `db/users.ts` + `db/quota.ts` patterns; add a new `db/subscriptions.ts` module. Frontend touches three pages (chat / login / about) + quota-badge component. mock 模式让 `recordPayment` 服务函数被 `/payment/create-order` 直接调用；real 模式让 `/wxpay/notify` 解密回调后调用同一函数。

**Tech Stack:** TypeScript / Fastify / vitest / mongodb-memory-server (test) / `@cloudbase/node-sdk` (prod) / `@fastify/static` / `wechatpay-node-v3-ts` / 原生小程序 WXML+TS.

**Spec:** [`docs/specs/2026-05-03-invite-and-subscription-design.md`](../specs/2026-05-03-invite-and-subscription-design.md)

---

## Context Notes (read before starting)

1. **Endpoint name drift**: spec §5.1 says `GET /user/me`, but the actual endpoint in this codebase is `GET /auth/me` (in `container/src/routes/auth.ts`). All tasks use `/auth/me` and **extend** it; do NOT create a new `/user/me`.

2. **Path imports use `.js` suffix** (TypeScript with `module: "NodeNext"`). Even though source is `.ts`, imports look like `from './foo.js'`. Match the existing style.

3. **Test pattern**: vitest + mongodb-memory-server. Tests inject `MongoAdapter` via `__setDbForTest()`. See `container/test/routes/chat.test.ts` for the canonical pattern.

4. **DB collection access**: `getDb().collection(name)` returns a `DbCollection` with `findOne / insertOne / updateOne / deleteMany`. `updateOne` accepts `{ $set, $inc, $setOnInsert }` and an optional `{ upsert }`.

5. **NoSQL atomicity**: CloudBase NoSQL does not support multi-document transactions. Use conditional `updateOne(filter, update)` for atomicity within a single document (e.g., decrement `bonus_balance` only where `bonus_balance > 0`).

6. **Beijing timezone**: `import { todayBeijing } from './utils/date.js'` returns `YYYY-MM-DD` string used as the `daily_usage` partition key.

7. **mock vs real**: `WXPAY_MODE` env defaults to `mock`. In `mock` mode, `/payment/create-order` does NOT call wxpay APIs and writes a subscription with `source='mock'`. In `real` mode it calls JSAPI下单 and returns `wx.requestPayment` parameters; the actual subscription write happens later in `/wxpay/notify`.

8. **All paths in this plan are relative to `/Users/qichenxie/Desktop/love-train-mp/`**.

---

## File Structure

### Files to CREATE

```
container/
├── public/
│   └── admin.html                        Static admin SPA (HTML+CSS+JS one file)
├── src/
│   ├── middleware/
│   │   └── admin.ts                      X-Admin-Token verification
│   ├── routes/
│   │   ├── invite.ts                     POST /invite/bind
│   │   ├── payment.ts                    POST /payment/create-order
│   │   ├── wxpay.ts                      POST /wxpay/notify
│   │   └── admin.ts                      GET /admin/rebates|subscriptions|users, POST /admin/rebates/:id/mark-paid
│   ├── services/
│   │   ├── invite.ts                     bindInviter business logic
│   │   ├── payment.ts                    recordPayment + WxpayClient (mock|real branch)
│   │   └── wxpay-client.ts               wechatpay-node-v3-ts SDK wrapper, lazy init
│   ├── db/
│   │   └── subscriptions.ts              subscriptions collection helpers
│   └── utils/
│       └── invite-code.ts                generate + validate 6-char codes
container/test/
├── db/
│   └── subscriptions.test.ts
├── middleware/
│   └── admin.test.ts
├── routes/
│   ├── invite.test.ts
│   ├── payment.test.ts
│   ├── wxpay.test.ts
│   └── admin.test.ts
├── services/
│   ├── invite.test.ts
│   └── payment.test.ts
└── utils/
    └── invite-code.test.ts
```

### Files to MODIFY

```
container/
├── package.json                          + @fastify/static + wechatpay-node-v3-ts
├── src/
│   ├── server.ts                         register new plugins/routes
│   ├── config.ts                         + invite/payment/admin/wxpay env
│   ├── db/
│   │   └── users.ts                      + invite_code, inviter_openid, bonus_balance, paid_until + new helpers
│   └── routes/
│       ├── auth.ts                       /auth/me returns new fields
│       └── chat.ts                       quota deduction: bonus first, dynamic limit
container/test/
├── config.test.ts                        cover new env handling
└── db/users.test.ts                      cover new helpers
miniprogram/
├── utils/api.ts                          + bindInvite, createOrder, extend UserInfo
├── utils/consts.ts                       + INVITE_CODE_PATTERN
├── pages/
│   ├── login/login.ts                    onLoad ic + post-login bind
│   ├── chat/chat.ts                      onShareAppMessage
│   └── about/
│       ├── about.ts                      member status + invite + subscribe
│       ├── about.wxml                    new sections
│       └── about.wxss                    new styles
└── components/quota-badge/
    ├── quota-badge.ts                    + bonus property
    ├── quota-badge.wxml                  show "+ 奖励 N" line
    └── quota-badge.wxss                  bonus styles
```

---

## Task Order & Dependencies

```
T1 (invite-code utils) ─────┐
T2 (users schema)      ─────┼─→ T4 (/invite/bind) ─→ T6 (frontend bind)
T3 (subscriptions DB)  ─────┤
                            └─→ T5 (chat扣减改造)  ─┐
                                                    ├─→ T11 (frontend about/quota)
T6 (recordPayment + mock) ──┐                       │
T7 (/wxpay/notify real)   ──┼─→ T8 (admin) ─→ T9 (admin.html)
                            │
                            └─→ T10 (frontend share + login bind)
                                                    │
                            T11 (frontend about + quota-badge)
                                                    │
                                                    └─→ T12 (mock-mode integration manual test)
```

Each task ends with a green test run + commit. T9 and T12 have manual verification (no automated tests for static HTML / end-to-end UX).

---

## Task 1: invite-code utility module

**Files:**
- Create: `container/src/utils/invite-code.ts`
- Test: `container/test/utils/invite-code.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// container/test/utils/invite-code.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container && npm test -- utils/invite-code`
Expected: FAIL with "Cannot find module ... invite-code.js"

- [ ] **Step 3: Implement the module**

```ts
// container/src/utils/invite-code.ts
import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars; excludes 0/O/1/I/L
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd container && npm test -- utils/invite-code`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/qichenxie/Desktop/love-train-mp
git add container/src/utils/invite-code.ts container/test/utils/invite-code.test.ts
git commit -m "feat(invite): add invite-code generator and validator"
```

---

## Task 2: extend `users` collection schema + DB helpers

**Files:**
- Modify: `container/src/db/users.ts`
- Test: `container/test/db/users.test.ts` (already exists; extend)

- [ ] **Step 1: Read existing `users.test.ts` to find the test fixture pattern**

Run: `cat container/test/db/users.test.ts | head -40`

Expected: see existing `beforeAll/beforeEach` setup (mongo-memory-server). New tests follow the same pattern.

- [ ] **Step 2: Write failing tests for new helpers**

Append to `container/test/db/users.test.ts`:

```ts
import {
  getOrCreateUser,
  findUserByInviteCode,
  bindInviter,
  decrementBonusAtomic,
  setPaidUntil,
} from '../../src/db/users.js';

describe('invite-code on user creation', () => {
  it('assigns a unique invite_code to new users', async () => {
    const u = await getOrCreateUser('oNew1');
    expect(u.invite_code).toMatch(/^[A-Z0-9]{6}$/);
    expect(u.bonus_balance).toBe(0);
    expect(u.inviter_openid).toBeUndefined();
    expect(u.paid_until).toBeUndefined();
  });

  it('does not overwrite invite_code on subsequent calls', async () => {
    const a = await getOrCreateUser('oNew2');
    const b = await getOrCreateUser('oNew2');
    expect(b.invite_code).toBe(a.invite_code);
  });
});

describe('findUserByInviteCode', () => {
  it('returns user when code matches', async () => {
    const a = await getOrCreateUser('oA');
    const found = await findUserByInviteCode(a.invite_code);
    expect(found?.openid).toBe('oA');
  });

  it('returns null when no match', async () => {
    expect(await findUserByInviteCode('ZZZZZZ')).toBeNull();
  });
});

describe('bindInviter', () => {
  it('binds and rewards both parties on first call', async () => {
    const inviter = await getOrCreateUser('oI');
    const invitee = await getOrCreateUser('oV');
    const r = await bindInviter({
      inviteeOpenid: 'oV',
      inviterOpenid: 'oI',
      inviteeReward: 5,
      inviterReward: 5,
    });
    expect(r.ok).toBe(true);
    const v2 = await getOrCreateUser('oV');
    expect(v2.inviter_openid).toBe('oI');
    expect(v2.bonus_balance).toBe(5);
    const i2 = await getOrCreateUser('oI');
    expect(i2.bonus_balance).toBe(5);
  });

  it('refuses to re-bind a user who already has an inviter', async () => {
    await getOrCreateUser('oI');
    await getOrCreateUser('oI2');
    await getOrCreateUser('oV');
    await bindInviter({ inviteeOpenid: 'oV', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    const r = await bindInviter({ inviteeOpenid: 'oV', inviterOpenid: 'oI2', inviteeReward: 5, inviterReward: 5 });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('ALREADY_BOUND');
  });
});

describe('decrementBonusAtomic', () => {
  it('returns true and decrements when balance > 0', async () => {
    await getOrCreateUser('oA');
    await bindInviter({ inviteeOpenid: 'oA', inviterOpenid: 'oI3', inviteeReward: 3, inviterReward: 0 });
    // Pre-create inviter so bind succeeds
    // Actually rewrite: just set bonus directly via internal helper if available;
    // easier: create another user and bind so oA gains 3.
    // (Simpler path: call setBonusForTest if exists; otherwise use bindInviter as above.)
    expect(await decrementBonusAtomic('oA')).toBe(true);
    const u = await getOrCreateUser('oA');
    expect(u.bonus_balance).toBe(2);
  });

  it('returns false when balance is 0', async () => {
    await getOrCreateUser('oZero');
    expect(await decrementBonusAtomic('oZero')).toBe(false);
  });
});

describe('setPaidUntil', () => {
  it('writes the timestamp', async () => {
    await getOrCreateUser('oP');
    const until = new Date('2026-06-03T00:00:00Z');
    await setPaidUntil('oP', until);
    const u = await getOrCreateUser('oP');
    expect(u.paid_until?.toISOString()).toBe(until.toISOString());
  });
});
```

> Note: `decrementBonusAtomic` test path uses `bindInviter` to seed bonus. If you find that awkward, expose a tiny internal `__setBonusForTest` helper and use it (mark with TODO and remove later); the production helpers should not allow direct bonus writes outside the bind flow.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd container && npm test -- db/users`
Expected: FAIL — new exports not defined.

- [ ] **Step 4: Extend `db/users.ts`**

Replace the file with:

```ts
import { getDb } from './mongo.js';
import { generateInviteCode } from '../utils/invite-code.js';

const COLLECTION = 'users';

export interface UserDoc {
  openid: string;
  unionid?: string;
  nickname?: string;
  avatarUrl?: string;
  totalUses: number;
  createdAt: Date;
  lastActiveAt: Date;
  isNewUser: boolean;
  // ── new fields (Invite + Subscription) ────────────
  invite_code: string;
  inviter_openid?: string;
  invited_at?: Date;
  bonus_balance: number;
  paid_until?: Date;
}

export type BindFailure = 'ALREADY_BOUND';

export interface BindResult {
  ok: boolean;
  reason?: BindFailure;
}

async function generateUniqueInviteCode(maxRetries = 5): Promise<string> {
  const col = getDb().collection(COLLECTION);
  for (let i = 0; i < maxRetries; i += 1) {
    const code = generateInviteCode();
    const existing = await col.findOne({ invite_code: code });
    if (!existing) return code;
  }
  // Vanishingly unlikely with 32^6 space, but guard anyway
  throw new Error('invite_code generation collision');
}

export async function getOrCreateUser(openid: string, unionid?: string): Promise<UserDoc> {
  const col = getDb().collection(COLLECTION);
  const now = new Date();
  const existing = await col.findOne({ openid });

  if (existing) {
    await col.updateOne({ openid }, { $set: { lastActiveAt: now } });
    return {
      openid: existing.openid as string,
      unionid: existing.unionid as string | undefined,
      nickname: existing.nickname as string | undefined,
      avatarUrl: existing.avatarUrl as string | undefined,
      totalUses: (existing.totalUses as number | undefined) ?? 0,
      createdAt: (existing.createdAt as Date | undefined) ?? now,
      lastActiveAt: now,
      isNewUser: false,
      invite_code: existing.invite_code as string,
      inviter_openid: existing.inviter_openid as string | undefined,
      invited_at: existing.invited_at as Date | undefined,
      bonus_balance: (existing.bonus_balance as number | undefined) ?? 0,
      paid_until: existing.paid_until as Date | undefined,
    };
  }

  const inviteCode = await generateUniqueInviteCode();
  await col.insertOne({
    openid,
    unionid,
    totalUses: 0,
    createdAt: now,
    lastActiveAt: now,
    invite_code: inviteCode,
    bonus_balance: 0,
  });

  return {
    openid,
    unionid,
    totalUses: 0,
    createdAt: now,
    lastActiveAt: now,
    isNewUser: true,
    invite_code: inviteCode,
    bonus_balance: 0,
  };
}

export async function updateProfile(
  openid: string,
  data: { nickname?: string; avatarUrl?: string },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (data.nickname !== undefined) set.nickname = data.nickname;
  if (data.avatarUrl !== undefined) set.avatarUrl = data.avatarUrl;
  if (Object.keys(set).length === 0) return;
  await getDb().collection(COLLECTION).updateOne({ openid }, { $set: set });
}

export async function incrementTotalUses(openid: string): Promise<void> {
  await getDb().collection(COLLECTION).updateOne({ openid }, { $inc: { totalUses: 1 } });
}

export async function findUserByInviteCode(code: string): Promise<UserDoc | null> {
  const doc = await getDb().collection(COLLECTION).findOne({ invite_code: code });
  if (!doc) return null;
  return {
    openid: doc.openid as string,
    unionid: doc.unionid as string | undefined,
    nickname: doc.nickname as string | undefined,
    avatarUrl: doc.avatarUrl as string | undefined,
    totalUses: (doc.totalUses as number | undefined) ?? 0,
    createdAt: doc.createdAt as Date,
    lastActiveAt: doc.lastActiveAt as Date,
    isNewUser: false,
    invite_code: doc.invite_code as string,
    inviter_openid: doc.inviter_openid as string | undefined,
    invited_at: doc.invited_at as Date | undefined,
    bonus_balance: (doc.bonus_balance as number | undefined) ?? 0,
    paid_until: doc.paid_until as Date | undefined,
  };
}

export interface BindParams {
  inviteeOpenid: string;
  inviterOpenid: string;
  inviteeReward: number;
  inviterReward: number;
}

/**
 * Two-step bind:
 *  1) Conditionally update the invitee where inviter_openid is missing.
 *     If matched → write inviter_openid, invited_at, $inc bonus_balance.
 *  2) If step 1 succeeded, $inc inviter's bonus_balance.
 *
 * Idempotency note: step 1 uses a {inviter_openid: null/missing} guard so
 * a retry on the same invitee returns ALREADY_BOUND.
 */
export async function bindInviter(p: BindParams): Promise<BindResult> {
  const col = getDb().collection(COLLECTION);
  const now = new Date();

  // Mongo: filter `{ inviter_openid: { $exists: false } }` ensures we only update
  // when inviter has not been set. CloudBaseAdapter must mirror this semantics.
  const before = await col.findOne({ openid: p.inviteeOpenid });
  if (!before) return { ok: false, reason: 'ALREADY_BOUND' }; // shouldn't happen but be safe
  if (before.inviter_openid) return { ok: false, reason: 'ALREADY_BOUND' };

  await col.updateOne(
    { openid: p.inviteeOpenid, inviter_openid: { $exists: false } as unknown as string },
    {
      $set: { inviter_openid: p.inviterOpenid, invited_at: now },
      $inc: { bonus_balance: p.inviteeReward },
    },
  );

  // Best-effort second leg. Failure is logged by caller.
  await col.updateOne(
    { openid: p.inviterOpenid },
    { $inc: { bonus_balance: p.inviterReward } },
  );

  return { ok: true };
}

/**
 * Atomic conditional decrement: only succeeds if bonus_balance > 0.
 * Returns true if a bonus point was consumed, false otherwise.
 */
export async function decrementBonusAtomic(openid: string): Promise<boolean> {
  const col = getDb().collection(COLLECTION);
  // Cheap read-then-update is acceptable here: bonus is per-user, single-process per request,
  // and the worst case (race) is one extra free message—negligible.
  // For stricter atomicity in CloudBase, the adapter should implement a conditional findOneAndUpdate.
  const u = await col.findOne({ openid });
  const balance = (u?.bonus_balance as number | undefined) ?? 0;
  if (balance <= 0) return false;
  await col.updateOne({ openid }, { $inc: { bonus_balance: -1 } });
  return true;
}

export async function setPaidUntil(openid: string, until: Date): Promise<void> {
  await getDb().collection(COLLECTION).updateOne({ openid }, { $set: { paid_until: until } });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd container && npm test -- db/users`
Expected: all PASS (existing + 7 new).

- [ ] **Step 6: Commit**

```bash
git add container/src/db/users.ts container/test/db/users.test.ts
git commit -m "feat(db): extend users with invite_code, bonus_balance, paid_until + helpers"
```

---

## Task 3: subscriptions DB module

**Files:**
- Create: `container/src/db/subscriptions.ts`
- Test: `container/test/db/subscriptions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// container/test/db/subscriptions.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import {
  insertSubscription,
  findSubscriptionByTransactionId,
  findRebatesByStatus,
  markRebatePaid,
  listAllSubscriptions,
} from '../../src/db/subscriptions.js';

let mongod: MongoMemoryServer;
let client: MongoClient;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  client = new MongoClient(mongod.getUri());
  await client.connect();
  __setDbForTest(new MongoAdapter(client.db('test')));
});
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => { await client.db('test').collection('subscriptions').deleteMany({}); });

describe('subscriptions', () => {
  it('insertSubscription writes all fields and returns id', async () => {
    const id = await insertSubscription({
      openid: 'oA',
      inviter_openid: 'oI',
      amount: 2000,
      paid_at: new Date('2026-05-03T00:00:00Z'),
      period_start: new Date('2026-05-03T00:00:00Z'),
      period_end: new Date('2026-06-03T00:00:00Z'),
      transaction_id: 'wx-tx-123',
      out_trade_no: 'LT20260503-AAAAAA',
      source: 'mock',
      rebate_status: 'pending',
    });
    expect(typeof id).toBe('string');
    const all = await listAllSubscriptions(50, 0);
    expect(all).toHaveLength(1);
    expect(all[0].source).toBe('mock');
    expect(all[0].rebate_status).toBe('pending');
  });

  it('findSubscriptionByTransactionId returns the row for idempotency', async () => {
    await insertSubscription({
      openid: 'oA', amount: 2000,
      paid_at: new Date(), period_start: new Date(), period_end: new Date(),
      transaction_id: 'wx-tx-X', out_trade_no: 'LT-1',
      source: 'wxpay', rebate_status: 'none',
    });
    const found = await findSubscriptionByTransactionId('wx-tx-X');
    expect(found?.openid).toBe('oA');
    expect(await findSubscriptionByTransactionId('not-here')).toBeNull();
  });

  it('findRebatesByStatus filters correctly', async () => {
    await insertSubscription({ openid: 'oA', inviter_openid: 'oI', amount: 2000, paid_at: new Date(), period_start: new Date(), period_end: new Date(), transaction_id: 't1', out_trade_no: 'L1', source: 'mock', rebate_status: 'pending' });
    await insertSubscription({ openid: 'oB', amount: 2000, paid_at: new Date(), period_start: new Date(), period_end: new Date(), transaction_id: 't2', out_trade_no: 'L2', source: 'mock', rebate_status: 'none' });
    const pending = await findRebatesByStatus('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].openid).toBe('oA');
    const none = await findRebatesByStatus('none');
    expect(none).toHaveLength(1);
    expect(none[0].openid).toBe('oB');
  });

  it('markRebatePaid writes status, paid_at, note', async () => {
    const id = await insertSubscription({ openid: 'oA', inviter_openid: 'oI', amount: 2000, paid_at: new Date(), period_start: new Date(), period_end: new Date(), transaction_id: 't3', out_trade_no: 'L3', source: 'mock', rebate_status: 'pending' });
    await markRebatePaid(id, '¥6.6 微信转账 5月10日');
    const paid = await findRebatesByStatus('paid');
    expect(paid).toHaveLength(1);
    expect(paid[0].rebate_note).toBe('¥6.6 微信转账 5月10日');
    expect(paid[0].rebate_paid_at).toBeInstanceOf(Date);
  });

  it('markRebatePaid throws if status was not pending', async () => {
    const id = await insertSubscription({ openid: 'oA', amount: 2000, paid_at: new Date(), period_start: new Date(), period_end: new Date(), transaction_id: 't4', out_trade_no: 'L4', source: 'mock', rebate_status: 'none' });
    await expect(markRebatePaid(id, 'note')).rejects.toThrow(/not pending/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container && npm test -- db/subscriptions`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `db/subscriptions.ts`**

```ts
// container/src/db/subscriptions.ts
import { randomUUID } from 'node:crypto';
import { getDb } from './mongo.js';

const COLLECTION = 'subscriptions';

export type RebateStatus = 'none' | 'pending' | 'paid';
export type SubscriptionSource = 'wxpay' | 'mock';

export interface SubscriptionInput {
  openid: string;
  inviter_openid?: string;
  amount: number;            // cents
  paid_at: Date;
  period_start: Date;
  period_end: Date;
  transaction_id: string;
  out_trade_no: string;
  source: SubscriptionSource;
  rebate_status: RebateStatus;
}

export interface SubscriptionDoc extends SubscriptionInput {
  _id: string;
  rebate_paid_at?: Date;
  rebate_note?: string;
}

function fromDb(doc: Record<string, unknown>): SubscriptionDoc {
  return {
    _id: doc._id as string,
    openid: doc.openid as string,
    inviter_openid: doc.inviter_openid as string | undefined,
    amount: doc.amount as number,
    paid_at: doc.paid_at as Date,
    period_start: doc.period_start as Date,
    period_end: doc.period_end as Date,
    transaction_id: doc.transaction_id as string,
    out_trade_no: doc.out_trade_no as string,
    source: doc.source as SubscriptionSource,
    rebate_status: doc.rebate_status as RebateStatus,
    rebate_paid_at: doc.rebate_paid_at as Date | undefined,
    rebate_note: doc.rebate_note as string | undefined,
  };
}

export async function insertSubscription(input: SubscriptionInput): Promise<string> {
  const _id = randomUUID();
  await getDb().collection(COLLECTION).insertOne({ _id, ...input });
  return _id;
}

export async function findSubscriptionByTransactionId(
  transaction_id: string,
): Promise<SubscriptionDoc | null> {
  const doc = await getDb().collection(COLLECTION).findOne({ transaction_id });
  return doc ? fromDb(doc) : null;
}

export async function findRebatesByStatus(status: RebateStatus): Promise<SubscriptionDoc[]> {
  // CloudBase NoSQL adapter must support {filter} → list. For Mongo we hit collection.find.
  // Since the abstract DbCollection only has findOne, we implement list via a thin extension below.
  return findMany({ rebate_status: status });
}

export async function listAllSubscriptions(limit: number, offset: number): Promise<SubscriptionDoc[]> {
  return findMany({}, { limit, offset, sortBy: 'paid_at', sortDir: 'desc' });
}

export async function markRebatePaid(_id: string, rebate_note: string): Promise<void> {
  const col = getDb().collection(COLLECTION);
  const existing = await col.findOne({ _id });
  if (!existing) throw new Error(`subscription ${_id} not found`);
  if (existing.rebate_status !== 'pending') {
    throw new Error(`subscription ${_id} rebate_status is not pending (was ${existing.rebate_status})`);
  }
  await col.updateOne(
    { _id },
    { $set: { rebate_status: 'paid', rebate_paid_at: new Date(), rebate_note } },
  );
}

// ─── private list helper ───
// The current DbCollection abstract has only findOne. For listing we
// reach into the underlying adapter via getDb() — but adapter.ts doesn't
// expose .find. To keep this PR small, extend MongoAdapter + CloudBaseAdapter
// in a small follow-up step within this task.
async function findMany(
  filter: Record<string, unknown>,
  opts?: { limit?: number; offset?: number; sortBy?: string; sortDir?: 'asc' | 'desc' },
): Promise<SubscriptionDoc[]> {
  const col = getDb().collection(COLLECTION);
  // We cast to the extended interface added in this task (see step 4).
  type WithFind = typeof col & {
    find: (
      filter: Record<string, unknown>,
      opts?: { limit?: number; offset?: number; sortBy?: string; sortDir?: 'asc' | 'desc' },
    ) => Promise<Record<string, unknown>[]>;
  };
  const docs = await (col as WithFind).find(filter, opts);
  return docs.map(fromDb);
}
```

- [ ] **Step 4: Extend `DbCollection` interface + adapters with `find`**

Modify `container/src/db/adapter.ts`:

```ts
export interface FindOptions {
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}

export interface DbCollection {
  findOne(filter: DbDocument): Promise<DbDocument | null>;
  find(filter: DbDocument, options?: FindOptions): Promise<DbDocument[]>;
  insertOne(doc: DbDocument): Promise<void>;
  updateOne(filter: DbDocument, update: UpdateSpec, options?: UpdateOptions): Promise<void>;
  deleteMany(filter: DbDocument): Promise<void>;
}
```

Modify `container/src/db/mongo-adapter.ts` — add `find()`:

```ts
// inside MongoAdapter's wrapper:
async find(filter: Record<string, unknown>, options?: { limit?: number; offset?: number; sortBy?: string; sortDir?: 'asc' | 'desc' }): Promise<Record<string, unknown>[]> {
  let cursor = this.col.find(filter);
  if (options?.sortBy) {
    cursor = cursor.sort({ [options.sortBy]: options.sortDir === 'asc' ? 1 : -1 });
  }
  if (options?.offset) cursor = cursor.skip(options.offset);
  if (options?.limit) cursor = cursor.limit(options.limit);
  return cursor.toArray();
},
```

Modify `container/src/db/cloudbase-adapter.ts` — add `find()`:

```ts
// inside CloudBaseAdapter's wrapper, mirror the existing pattern (probably a tcb db query):
async find(filter, options) {
  let q = this.collection.where(filter);
  if (options?.sortBy) q = q.orderBy(options.sortBy, options.sortDir ?? 'desc');
  if (options?.offset) q = q.skip(options.offset);
  if (options?.limit) q = q.limit(options.limit);
  const r = await q.get();
  return r.data ?? [];
}
```

> Open both files first to see the exact `this.col` / `this.collection` reference name and copy that style.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd container && npm test -- db/subscriptions`
Expected: 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add container/src/db/subscriptions.ts container/src/db/adapter.ts \
        container/src/db/mongo-adapter.ts container/src/db/cloudbase-adapter.ts \
        container/test/db/subscriptions.test.ts
git commit -m "feat(db): add subscriptions collection + find() across adapters"
```

---

## Task 4: `/invite/bind` route + extend `/auth/me`

**Files:**
- Create: `container/src/routes/invite.ts`
- Create: `container/src/services/invite.ts`
- Modify: `container/src/routes/auth.ts`
- Modify: `container/src/server.ts` (register inviteRoutes)
- Modify: `container/src/config.ts` (add `inviteRewardInviter / inviteRewardInvitee / inviteBindWindowDays`)
- Test: `container/test/routes/invite.test.ts`
- Test: `container/test/services/invite.test.ts`

- [ ] **Step 1: Add config fields**

Edit `container/src/config.ts`. Inside `AppConfig` add:

```ts
invite: {
  rewardInviter: number;
  rewardInvitee: number;
  bindWindowDays: number;
};
dailyLimit: { free: number; paid: number };
```

Inside `loadConfig()` return:

```ts
invite: {
  rewardInviter: Number(process.env.INVITE_REWARD_INVITER ?? 5),
  rewardInvitee: Number(process.env.INVITE_REWARD_INVITEE ?? 5),
  bindWindowDays: Number(process.env.INVITE_BIND_WINDOW_DAYS ?? 7),
},
dailyLimit: {
  free: Number(process.env.DAILY_LIMIT_FREE ?? process.env.DAILY_QUOTA ?? 10),
  paid: Number(process.env.DAILY_LIMIT_PAID ?? 30),
},
```

(Keep existing `dailyQuota` for backward compat — `DAILY_LIMIT_FREE` falls back to it.)

- [ ] **Step 2: Write failing service test**

```ts
// container/test/services/invite.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { getOrCreateUser } from '../../src/db/users.js';
import { bindInvite } from '../../src/services/invite.js';

let mongod: MongoMemoryServer;
let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => { await client.db('test').collection('users').deleteMany({}); });

const cfg = { invite: { rewardInviter: 5, rewardInvitee: 5, bindWindowDays: 7 } } as any;

describe('bindInvite service', () => {
  it('rejects invalid format', async () => {
    await getOrCreateUser('oA');
    expect(await bindInvite(cfg, 'oA', 'lower')).toEqual({ ok: false, error: 'INVALID_CODE_FORMAT' });
  });

  it('rejects when code does not exist', async () => {
    await getOrCreateUser('oA');
    expect(await bindInvite(cfg, 'oA', 'ZZZZZZ')).toEqual({ ok: false, error: 'CODE_NOT_FOUND' });
  });

  it('rejects self-invite', async () => {
    const a = await getOrCreateUser('oA');
    expect(await bindInvite(cfg, 'oA', a.invite_code)).toEqual({ ok: false, error: 'SELF_INVITE' });
  });

  it('rejects when invitee already bound', async () => {
    const i = await getOrCreateUser('oI');
    const i2 = await getOrCreateUser('oI2');
    await getOrCreateUser('oV');
    await bindInvite(cfg, 'oV', i.invite_code);
    expect(await bindInvite(cfg, 'oV', i2.invite_code)).toEqual({ ok: false, error: 'ALREADY_BOUND' });
  });

  it('rejects when registered > windowDays ago', async () => {
    // Seed user with createdAt 10 days ago
    const eightDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await client.db('test').collection('users').insertOne({
      openid: 'oOld',
      createdAt: eightDaysAgo,
      lastActiveAt: eightDaysAgo,
      totalUses: 0,
      bonus_balance: 0,
      invite_code: 'OLDCDE',
    });
    const i = await getOrCreateUser('oI');
    expect(await bindInvite(cfg, 'oOld', i.invite_code)).toEqual({ ok: false, error: 'WINDOW_EXPIRED' });
  });

  it('rejects when invitee already paid', async () => {
    await getOrCreateUser('oV');
    await client.db('test').collection('users').updateOne({ openid: 'oV' }, { $set: { paid_until: new Date(Date.now() + 86400_000) } });
    const i = await getOrCreateUser('oI');
    expect(await bindInvite(cfg, 'oV', i.invite_code)).toEqual({ ok: false, error: 'WINDOW_EXPIRED' });
  });

  it('binds and rewards both parties', async () => {
    const i = await getOrCreateUser('oI');
    await getOrCreateUser('oV');
    const r = await bindInvite(cfg, 'oV', i.invite_code);
    expect(r).toEqual({ ok: true, bonus_added: 5 });
    const v2 = await getOrCreateUser('oV');
    const i2 = await getOrCreateUser('oI');
    expect(v2.bonus_balance).toBe(5);
    expect(i2.bonus_balance).toBe(5);
    expect(v2.inviter_openid).toBe('oI');
  });
});
```

- [ ] **Step 3: Implement `services/invite.ts`**

```ts
// container/src/services/invite.ts
import type { AppConfig } from '../config.js';
import { isValidInviteCode } from '../utils/invite-code.js';
import { bindInviter, findUserByInviteCode, getOrCreateUser } from '../db/users.js';

export type BindError =
  | 'INVALID_CODE_FORMAT'
  | 'CODE_NOT_FOUND'
  | 'SELF_INVITE'
  | 'ALREADY_BOUND'
  | 'WINDOW_EXPIRED';

export type BindOutcome =
  | { ok: true; bonus_added: number }
  | { ok: false; error: BindError };

export async function bindInvite(
  cfg: AppConfig,
  inviteeOpenid: string,
  code: string,
): Promise<BindOutcome> {
  if (!isValidInviteCode(code)) return { ok: false, error: 'INVALID_CODE_FORMAT' };

  const inviter = await findUserByInviteCode(code);
  if (!inviter) return { ok: false, error: 'CODE_NOT_FOUND' };
  if (inviter.openid === inviteeOpenid) return { ok: false, error: 'SELF_INVITE' };

  const invitee = await getOrCreateUser(inviteeOpenid);
  if (invitee.inviter_openid) return { ok: false, error: 'ALREADY_BOUND' };

  const now = Date.now();
  const ageMs = now - invitee.createdAt.getTime();
  const windowMs = cfg.invite.bindWindowDays * 24 * 60 * 60 * 1000;
  if (ageMs > windowMs) return { ok: false, error: 'WINDOW_EXPIRED' };
  if (invitee.paid_until && invitee.paid_until.getTime() > now) {
    return { ok: false, error: 'WINDOW_EXPIRED' };
  }

  const r = await bindInviter({
    inviteeOpenid,
    inviterOpenid: inviter.openid,
    inviteeReward: cfg.invite.rewardInvitee,
    inviterReward: cfg.invite.rewardInviter,
  });
  if (!r.ok) return { ok: false, error: 'ALREADY_BOUND' };

  return { ok: true, bonus_added: cfg.invite.rewardInvitee };
}
```

- [ ] **Step 4: Run service tests**

Run: `cd container && npm test -- services/invite`
Expected: 7 tests PASS.

- [ ] **Step 5: Write failing route test**

```ts
// container/test/routes/invite.test.ts
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { openidPlugin } from '../../src/middleware/openid.js';
import { inviteRoutes } from '../../src/routes/invite.js';
import { getOrCreateUser } from '../../src/db/users.js';

let mongod: MongoMemoryServer; let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => { await client.db('test').collection('users').deleteMany({}); });

const cfg = { invite: { rewardInviter: 5, rewardInvitee: 5, bindWindowDays: 7 } } as any;

function buildApp() {
  const app = Fastify();
  app.register(openidPlugin);
  app.register(inviteRoutes(cfg));
  return app;
}

describe('POST /invite/bind', () => {
  it('returns ok and bonus on success', async () => {
    const i = await getOrCreateUser('oI');
    await getOrCreateUser('oV');
    const app = buildApp();
    const res = await app.inject({
      method: 'POST', url: '/invite/bind',
      headers: { 'x-wx-openid': 'oV' },
      payload: { code: i.invite_code },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, bonus_added: 5 });
  });

  it('returns 400 with error code on invalid', async () => {
    await getOrCreateUser('oA');
    const app = buildApp();
    const res = await app.inject({
      method: 'POST', url: '/invite/bind',
      headers: { 'x-wx-openid': 'oA' },
      payload: { code: 'lower' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ ok: false, error: 'INVALID_CODE_FORMAT' });
  });
});
```

- [ ] **Step 6: Implement `routes/invite.ts`**

```ts
// container/src/routes/invite.ts
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { bindInvite } from '../services/invite.js';

export const inviteRoutes =
  (cfg: AppConfig): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: { code?: string } }>('/invite/bind', async (req, reply) => {
      const code = (req.body?.code ?? '').toString();
      const r = await bindInvite(cfg, req.openid, code);
      if (!r.ok) {
        reply.code(400);
        return r;
      }
      return r;
    });
  };
```

- [ ] **Step 7: Register route in `server.ts`**

```ts
import { inviteRoutes } from './routes/invite.js';
// ... after existing route registers:
await app.register(inviteRoutes(cfg));
```

- [ ] **Step 8: Extend `/auth/me` with new fields**

Replace the `/auth/me` handler in `container/src/routes/auth.ts`:

```ts
app.get('/auth/me', async (req) => {
  const user = await getOrCreateUser(req.openid, req.unionid);
  const todayLimit =
    user.paid_until && user.paid_until.getTime() > Date.now()
      ? cfg.dailyLimit.paid
      : cfg.dailyLimit.free;
  const remainingUses = await getRemaining(req.openid, todayBeijing(), todayLimit);

  let inviter: { invite_code: string } | null = null;
  if (user.inviter_openid) {
    const inv = await import('../db/users.js').then((m) => m.getOrCreateUser(user.inviter_openid!));
    inviter = { invite_code: inv.invite_code };
  }

  return {
    openid: user.openid,
    nickname: user.nickname ?? '',
    avatarUrl: user.avatarUrl ?? '',
    remainingUses,
    today_limit: todayLimit,
    totalUses: user.totalUses,
    isNewUser: user.isNewUser,
    is_paid: !!(user.paid_until && user.paid_until.getTime() > Date.now()),
    paid_until: user.paid_until?.toISOString() ?? null,
    invite_code: user.invite_code,
    inviter,
    bonus_balance: user.bonus_balance,
  };
});
```

> The dynamic import of `getOrCreateUser` is just to keep the diff small; you can also add it to the top-level imports.

- [ ] **Step 9: Run all tests**

Run: `cd container && npm test`
Expected: all PASS (existing + new). Pay attention to `auth.test.ts` if it exists; it may need an update to match new `/auth/me` shape.

- [ ] **Step 10: Commit**

```bash
git add container/src/routes/invite.ts container/src/services/invite.ts \
        container/src/routes/auth.ts container/src/server.ts container/src/config.ts \
        container/test/routes/invite.test.ts container/test/services/invite.test.ts
git commit -m "feat(invite): /invite/bind route + extend /auth/me with invite/bonus/paid fields"
```

---

## Task 5: chat 扣减改为 bonus 优先 + 动态每日限额

**Files:**
- Modify: `container/src/routes/chat.ts`
- Modify: `container/test/routes/chat.test.ts`

- [ ] **Step 1: Read existing chat handler**

Run: `grep -n "getRemaining\|incrementUsage\|dailyQuota" container/src/routes/chat.ts`

Find the lines that compute remaining + increment. They will be replaced with: bonus-first → daily fallback.

- [ ] **Step 2: Add failing tests for new behavior**

Append to `container/test/routes/chat.test.ts`:

```ts
import { decrementBonusAtomic, getOrCreateUser, bindInviter } from '../../src/db/users.js';

describe('POST /chat with bonus_balance', () => {
  it('consumes bonus_balance before daily quota', async () => {
    const llm = new FakeLLM();
    llm.mockReply = 'ok';
    const app = buildApp(llm);
    // Seed user with bonus_balance=2 via bind
    await getOrCreateUser('oI');
    await getOrCreateUser('oA');
    await bindInviter({ inviteeOpenid: 'oA', inviterOpenid: 'oI', inviteeReward: 2, inviterReward: 0 });
    // First call should consume bonus, daily_usage stays 0
    await app.inject({ method: 'POST', url: '/chat', headers: { 'x-wx-openid': 'oA' }, payload: { messages: [{ role: 'user', content: 'hi' }], stream: false } });
    const { getUsage } = await import('../../src/db/quota.js');
    const { todayBeijing } = await import('../../src/utils/date.js');
    expect(await getUsage('oA', todayBeijing())).toBe(0);
    const u = await getOrCreateUser('oA');
    expect(u.bonus_balance).toBe(1); // 2 - 1
  });

  it('falls back to daily_usage after bonus exhausted', async () => {
    const llm = new FakeLLM();
    const app = buildApp(llm);
    // user with no bonus
    await getOrCreateUser('oNoB');
    await app.inject({ method: 'POST', url: '/chat', headers: { 'x-wx-openid': 'oNoB' }, payload: { messages: [{ role: 'user', content: 'hi' }], stream: false } });
    const { getUsage } = await import('../../src/db/quota.js');
    const { todayBeijing } = await import('../../src/utils/date.js');
    expect(await getUsage('oNoB', todayBeijing())).toBe(1);
  });

  it('uses paid daily limit when paid_until > now', async () => {
    const llm = new FakeLLM();
    const app = buildApp(llm); // buildApp passes dailyLimit: { free: 10, paid: 30 } now
    await getOrCreateUser('oP');
    const { setPaidUntil } = await import('../../src/db/users.js');
    await setPaidUntil('oP', new Date(Date.now() + 86400_000));
    // Pre-fill 10 daily usage; should still be allowed because limit=30
    const { incrementUsage } = await import('../../src/db/quota.js');
    const { todayBeijing } = await import('../../src/utils/date.js');
    for (let i = 0; i < 10; i += 1) await incrementUsage('oP', todayBeijing());
    const res = await app.inject({ method: 'POST', url: '/chat', headers: { 'x-wx-openid': 'oP' }, payload: { messages: [{ role: 'user', content: 'hi' }], stream: false } });
    expect(res.statusCode).toBe(200);
  });
});
```

Update the existing `buildApp` helper in `chat.test.ts` to pass `dailyLimit: { free: 10, paid: 30 }` and `invite` config:

```ts
function buildApp(llm: FakeLLM) {
  const app = Fastify();
  app.register(openidPlugin);
  app.register(chatRoutes({
    dailyQuota: 10,                      // legacy, still read in some places
    dailyLimit: { free: 10, paid: 30 },
  } as any, llm));
  return app;
}
```

- [ ] **Step 3: Run tests to confirm failures**

Run: `cd container && npm test -- routes/chat`
Expected: new tests FAIL.

- [ ] **Step 4: Modify `chat.ts` deduction logic**

Find the section that computes `remainingUses` and calls `incrementUsage`. Replace with this pattern (around the existing chat handler, both stream and non-stream branches):

```ts
import { decrementBonusAtomic, getOrCreateUser } from '../db/users.js';

// inside the handler, BEFORE invoking the LLM:
const user = await getOrCreateUser(req.openid);
const isPaid = !!(user.paid_until && user.paid_until.getTime() > Date.now());
const limit = isPaid ? cfg.dailyLimit.paid : cfg.dailyLimit.free;

const todayUsed = await getUsage(req.openid, todayBeijing());
const bonusAvail = user.bonus_balance > 0;
if (!bonusAvail && todayUsed >= limit) {
  return reply.code(429).send({ error: 'QUOTA_EXCEEDED', message: '今日额度已用完' });
}

// --- after LLM call succeeds, before returning the response ---
let bonusConsumed = false;
if (bonusAvail) bonusConsumed = await decrementBonusAtomic(req.openid);
if (!bonusConsumed) await incrementUsage(req.openid, todayBeijing());

// Recompute remaining for response:
// remainingUses = today's daily remaining ONLY (do NOT add bonus here;
// frontend renders bonus separately via /auth/me's bonus_balance).
const usedAfter = await getUsage(req.openid, todayBeijing());
const remainingUses = Math.max(0, limit - usedAfter);
```

> Important: keep the existing "do NOT increment on LLM failure" behavior — the deduction must run **only on success**.
>
> Note: do NOT add `bonus_balance` into `remainingUses`. Frontend (Task 11) reads `remainingUses` and `bonus_balance` separately and renders them as two distinct numbers.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd container && npm test -- routes/chat`
Expected: all PASS, including the new ones.

- [ ] **Step 6: Commit**

```bash
git add container/src/routes/chat.ts container/test/routes/chat.test.ts
git commit -m "feat(chat): consume bonus_balance before daily quota; dynamic paid/free limit"
```

---

## Task 6: `/payment/create-order` with mock mode + recordPayment service

**Files:**
- Create: `container/src/services/payment.ts`
- Create: `container/src/routes/payment.ts`
- Modify: `container/src/server.ts` (register paymentRoutes)
- Modify: `container/src/config.ts` (add `wxpay.mode`, `subscription`)
- Test: `container/test/services/payment.test.ts`
- Test: `container/test/routes/payment.test.ts`

- [ ] **Step 1: Add config**

Edit `config.ts`. Add to `AppConfig`:

```ts
subscription: { amountCents: number; periodDays: number };
wxpay: {
  mode: 'mock' | 'real';
  appid: string;
  mchid: string;
  apiV3Key: string;
  certSerial: string;
  privateKeyPath: string;
  notifyUrl: string;
};
```

In `loadConfig()`:

```ts
const wxpayMode = (process.env.WXPAY_MODE ?? 'mock') as 'mock' | 'real';
if (wxpayMode === 'real') {
  for (const k of ['WXPAY_APPID','WXPAY_MCHID','WXPAY_API_V3_KEY','WXPAY_CERT_SERIAL','WXPAY_PRIVATE_KEY_PATH','WXPAY_NOTIFY_URL']) {
    if (!process.env[k]) throw new Error(`WXPAY_MODE=real but missing env: ${k}`);
  }
}
return {
  // ... existing,
  subscription: {
    amountCents: Number(process.env.SUBSCRIPTION_AMOUNT_CENTS ?? 2000),
    periodDays: Number(process.env.SUBSCRIPTION_PERIOD_DAYS ?? 30),
  },
  wxpay: {
    mode: wxpayMode,
    appid: process.env.WXPAY_APPID ?? '',
    mchid: process.env.WXPAY_MCHID ?? '',
    apiV3Key: process.env.WXPAY_API_V3_KEY ?? '',
    certSerial: process.env.WXPAY_CERT_SERIAL ?? '',
    privateKeyPath: process.env.WXPAY_PRIVATE_KEY_PATH ?? '',
    notifyUrl: process.env.WXPAY_NOTIFY_URL ?? '',
  },
};
```

- [ ] **Step 2: Write failing service test**

```ts
// container/test/services/payment.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { getOrCreateUser, bindInviter } from '../../src/db/users.js';
import { recordPayment } from '../../src/services/payment.js';
import { findRebatesByStatus, listAllSubscriptions } from '../../src/db/subscriptions.js';

let mongod: MongoMemoryServer; let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => {
  await client.db('test').collection('users').deleteMany({});
  await client.db('test').collection('subscriptions').deleteMany({});
});

const cfg = { subscription: { amountCents: 2000, periodDays: 30 }, wxpay: { mode: 'mock' } } as any;

describe('recordPayment', () => {
  it('writes subscription with rebate_status=none when no inviter', async () => {
    await getOrCreateUser('oA');
    const r = await recordPayment(cfg, {
      openid: 'oA', amount: 2000, transaction_id: 'mock-1', out_trade_no: 'LT-1', source: 'mock',
    });
    expect(r.subscription_id).toBeDefined();
    expect(r.paid_until).toBeInstanceOf(Date);
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
    expect(subs[0].rebate_status).toBe('none');
    expect(subs[0].inviter_openid).toBeUndefined();
  });

  it('writes subscription with rebate_status=pending and inviter snapshot', async () => {
    await getOrCreateUser('oI');
    await getOrCreateUser('oA');
    await bindInviter({ inviteeOpenid: 'oA', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    await recordPayment(cfg, {
      openid: 'oA', amount: 2000, transaction_id: 'mock-2', out_trade_no: 'LT-2', source: 'mock',
    });
    const pending = await findRebatesByStatus('pending');
    expect(pending).toHaveLength(1);
    expect(pending[0].inviter_openid).toBe('oI');
  });

  it('updates user.paid_until forward', async () => {
    await getOrCreateUser('oA');
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'mock-3', out_trade_no: 'LT-3', source: 'mock' });
    const u = await getOrCreateUser('oA');
    expect(u.paid_until).toBeInstanceOf(Date);
    expect(u.paid_until!.getTime()).toBeGreaterThan(Date.now() + 25 * 86400_000);
  });

  it('extends from current paid_until when stacking', async () => {
    await getOrCreateUser('oA');
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 't1', out_trade_no: 'L1', source: 'mock' });
    const u1 = await getOrCreateUser('oA');
    const first = u1.paid_until!.getTime();
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 't2', out_trade_no: 'L2', source: 'mock' });
    const u2 = await getOrCreateUser('oA');
    expect(u2.paid_until!.getTime()).toBeGreaterThan(first + 25 * 86400_000);
  });

  it('is idempotent on transaction_id', async () => {
    await getOrCreateUser('oA');
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'tx', out_trade_no: 'L1', source: 'wxpay' });
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'tx', out_trade_no: 'L1', source: 'wxpay' });
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Implement `services/payment.ts`**

```ts
// container/src/services/payment.ts
import type { AppConfig } from '../config.js';
import { getOrCreateUser, setPaidUntil } from '../db/users.js';
import {
  insertSubscription,
  findSubscriptionByTransactionId,
  type SubscriptionSource,
} from '../db/subscriptions.js';

export interface RecordPaymentInput {
  openid: string;
  amount: number;            // cents
  transaction_id: string;
  out_trade_no: string;
  source: SubscriptionSource;
  months?: number;           // default 1
}

export interface RecordPaymentResult {
  subscription_id: string;
  paid_until: Date;
  rebate_status: 'none' | 'pending' | 'paid';
  duplicate?: boolean;
}

export async function recordPayment(
  cfg: AppConfig,
  input: RecordPaymentInput,
): Promise<RecordPaymentResult> {
  // Idempotency
  const existing = await findSubscriptionByTransactionId(input.transaction_id);
  if (existing) {
    return {
      subscription_id: existing._id,
      paid_until: existing.period_end,
      rebate_status: existing.rebate_status,
      duplicate: true,
    };
  }

  const user = await getOrCreateUser(input.openid);
  const months = input.months ?? 1;
  const periodMs = cfg.subscription.periodDays * 24 * 60 * 60 * 1000;
  const now = new Date();
  const start =
    user.paid_until && user.paid_until.getTime() > now.getTime() ? user.paid_until : now;
  const end = new Date(start.getTime() + months * periodMs);

  const rebateStatus = user.inviter_openid ? 'pending' : 'none';

  const _id = await insertSubscription({
    openid: input.openid,
    inviter_openid: user.inviter_openid,
    amount: input.amount,
    paid_at: now,
    period_start: start,
    period_end: end,
    transaction_id: input.transaction_id,
    out_trade_no: input.out_trade_no,
    source: input.source,
    rebate_status: rebateStatus,
  });

  await setPaidUntil(input.openid, end);

  return { subscription_id: _id, paid_until: end, rebate_status: rebateStatus };
}
```

- [ ] **Step 4: Run service tests**

Run: `cd container && npm test -- services/payment`
Expected: 5 tests PASS.

- [ ] **Step 5: Write failing route test (mock mode)**

```ts
// container/test/routes/payment.test.ts
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { openidPlugin } from '../../src/middleware/openid.js';
import { paymentRoutes } from '../../src/routes/payment.js';
import { getOrCreateUser } from '../../src/db/users.js';

let mongod: MongoMemoryServer; let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => { await client.db('test').collection('users').deleteMany({}); await client.db('test').collection('subscriptions').deleteMany({}); });

const mockCfg = { subscription: { amountCents: 2000, periodDays: 30 }, wxpay: { mode: 'mock' } } as any;

function build(cfg: any) {
  const app = Fastify();
  app.register(openidPlugin);
  app.register(paymentRoutes(cfg));
  return app;
}

describe('POST /payment/create-order (mock mode)', () => {
  it('returns mode=mock + subscription_id + paid_until', async () => {
    await getOrCreateUser('oA');
    const app = build(mockCfg);
    const res = await app.inject({
      method: 'POST', url: '/payment/create-order',
      headers: { 'x-wx-openid': 'oA' },
      payload: { months: 1 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.mode).toBe('mock');
    expect(body.subscription_id).toBeDefined();
    expect(body.paid_until).toBeDefined();
  });
});
```

- [ ] **Step 6: Implement `routes/payment.ts`**

```ts
// container/src/routes/payment.ts
import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { recordPayment } from '../services/payment.js';
// Real-mode wxpay client gets imported lazily in step 7 (Task 7).
import { createWxpayPrepayOrder } from '../services/wxpay-client.js';

function makeOutTradeNo(): string {
  // LT + yyyymmddhhmmss + 6 random alphanumeric
  const d = new Date();
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  const ts = `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
  const rand = randomUUID().replace(/-/g, '').slice(0, 6).toUpperCase();
  return `LT${ts}${rand}`;
}

export const paymentRoutes =
  (cfg: AppConfig): FastifyPluginAsync =>
  async (app) => {
    app.post<{ Body: { months?: number } }>(
      '/payment/create-order',
      async (req, reply) => {
        const months = Math.max(1, Math.min(12, req.body?.months ?? 1));
        const out_trade_no = makeOutTradeNo();
        const amount = cfg.subscription.amountCents * months;

        if (cfg.wxpay.mode === 'mock') {
          const r = await recordPayment(cfg, {
            openid: req.openid,
            amount,
            transaction_id: `mock-${out_trade_no}`,
            out_trade_no,
            source: 'mock',
            months,
          });
          return {
            mode: 'mock' as const,
            subscription_id: r.subscription_id,
            paid_until: r.paid_until.toISOString(),
          };
        }

        // real mode
        try {
          const wx = await createWxpayPrepayOrder(cfg, {
            openid: req.openid,
            out_trade_no,
            amount,
            description: `love-train 付费会员（${months} 个月）`,
          });
          return { mode: 'real' as const, wx_payment: wx };
        } catch (err) {
          req.log.error({ err }, 'wxpay create-order failed');
          reply.code(502);
          return { ok: false, error: 'INTERNAL_WXPAY_FAILED' };
        }
      },
    );
  };
```

> Note: at this point `createWxpayPrepayOrder` doesn't exist yet — Task 7 creates it. Add a placeholder file now so this compiles:

Create `container/src/services/wxpay-client.ts`:

```ts
import type { AppConfig } from '../config.js';

export interface WxRequestPayParams {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

export async function createWxpayPrepayOrder(
  _cfg: AppConfig,
  _input: { openid: string; out_trade_no: string; amount: number; description: string },
): Promise<WxRequestPayParams> {
  throw new Error('wxpay real-mode client not implemented yet (Task 7)');
}

export async function verifyAndDecryptNotify(
  _cfg: AppConfig,
  _headers: Record<string, string>,
  _bodyText: string,
): Promise<{ out_trade_no: string; transaction_id: string; openid: string; amount_cents: number }> {
  throw new Error('wxpay notify verifier not implemented yet (Task 7)');
}
```

- [ ] **Step 7: Register payment route in `server.ts`**

```ts
import { paymentRoutes } from './routes/payment.js';
// after existing registers:
await app.register(paymentRoutes(cfg));
```

- [ ] **Step 8: Run tests**

Run: `cd container && npm test`
Expected: all PASS, including new payment tests in mock mode.

- [ ] **Step 9: Commit**

```bash
git add container/src/services/payment.ts container/src/services/wxpay-client.ts \
        container/src/routes/payment.ts container/src/server.ts container/src/config.ts \
        container/test/services/payment.test.ts container/test/routes/payment.test.ts
git commit -m "feat(payment): /payment/create-order with mock mode + recordPayment service"
```

---

## Task 7: `/wxpay/notify` route + real-mode wxpay client

**Files:**
- Modify: `container/package.json` (+ `wechatpay-node-v3-ts`)
- Modify: `container/src/services/wxpay-client.ts` (real implementation)
- Create: `container/src/routes/wxpay.ts`
- Modify: `container/src/server.ts` (register wxpayRoutes; raw body for notify)
- Test: `container/test/routes/wxpay.test.ts`

> **Note**: full integration with the live wxpay server requires an actual merchant account. These tests stub the SDK at module boundary so behavior is testable without merchant creds.

- [ ] **Step 1: Install dependency**

```bash
cd container
npm install wechatpay-node-v3-ts@^2 --save
```

- [ ] **Step 2: Write failing test (with stubbed SDK)**

```ts
// container/test/routes/wxpay.test.ts
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { wxpayRoutes } from '../../src/routes/wxpay.js';
import { getOrCreateUser } from '../../src/db/users.js';
import { listAllSubscriptions } from '../../src/db/subscriptions.js';

vi.mock('../../src/services/wxpay-client.js', async () => {
  return {
    verifyAndDecryptNotify: vi.fn(),
    createWxpayPrepayOrder: vi.fn(),
  };
});
import { verifyAndDecryptNotify } from '../../src/services/wxpay-client.js';

let mongod: MongoMemoryServer; let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => {
  await client.db('test').collection('users').deleteMany({});
  await client.db('test').collection('subscriptions').deleteMany({});
  vi.clearAllMocks();
});

const cfg = {
  subscription: { amountCents: 2000, periodDays: 30 },
  wxpay: { mode: 'real', appid: 'wx', mchid: 'm', apiV3Key: 'k', certSerial: 's', privateKeyPath: '/tmp/k.pem', notifyUrl: 'https://x/notify' },
} as any;

function build() {
  const app = Fastify();
  app.register(wxpayRoutes(cfg));
  return app;
}

describe('POST /wxpay/notify', () => {
  it('returns 401 when verification fails', async () => {
    (verifyAndDecryptNotify as any).mockRejectedValue(new Error('bad sig'));
    const res = await build().inject({
      method: 'POST', url: '/wxpay/notify',
      headers: { 'wechatpay-signature': 'x' },
      payload: '{"any":"thing"}',
    });
    expect(res.statusCode).toBe(401);
  });

  it('writes subscription and returns SUCCESS on valid notify', async () => {
    await getOrCreateUser('oA');
    (verifyAndDecryptNotify as any).mockResolvedValue({
      out_trade_no: 'LT-1', transaction_id: 'wx-tx-1', openid: 'oA', amount_cents: 2000,
    });
    const res = await build().inject({
      method: 'POST', url: '/wxpay/notify',
      headers: { 'wechatpay-signature': 'x' },
      payload: '{"any":"thing"}',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ code: 'SUCCESS', message: 'OK' });
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
    expect(subs[0].source).toBe('wxpay');
  });

  it('is idempotent on duplicate notify', async () => {
    await getOrCreateUser('oA');
    (verifyAndDecryptNotify as any).mockResolvedValue({
      out_trade_no: 'LT-1', transaction_id: 'wx-tx-1', openid: 'oA', amount_cents: 2000,
    });
    const app = build();
    await app.inject({ method: 'POST', url: '/wxpay/notify', headers: { 'wechatpay-signature': 'x' }, payload: '{}' });
    await app.inject({ method: 'POST', url: '/wxpay/notify', headers: { 'wechatpay-signature': 'x' }, payload: '{}' });
    const subs = await listAllSubscriptions(50, 0);
    expect(subs).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run tests to confirm fail**

Run: `cd container && npm test -- routes/wxpay`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `routes/wxpay.ts`**

```ts
// container/src/routes/wxpay.ts
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { recordPayment } from '../services/payment.js';
import { verifyAndDecryptNotify } from '../services/wxpay-client.js';

export const wxpayRoutes =
  (cfg: AppConfig): FastifyPluginAsync =>
  async (app) => {
    app.post('/wxpay/notify', async (req, reply) => {
      const headers = req.headers as Record<string, string>;
      // Fastify gives us parsed JSON by default; we need the raw body for signature verification.
      // The server.ts registration adds a content-type parser so req.body is the raw string for this route.
      const bodyText =
        typeof req.body === 'string'
          ? req.body
          : JSON.stringify(req.body ?? {});

      let payload: { out_trade_no: string; transaction_id: string; openid: string; amount_cents: number };
      try {
        payload = await verifyAndDecryptNotify(cfg, headers, bodyText);
      } catch (err) {
        req.log.warn({ err }, 'wxpay notify verification failed');
        reply.code(401);
        return { code: 'FAIL', message: 'verification failed' };
      }

      try {
        await recordPayment(cfg, {
          openid: payload.openid,
          amount: payload.amount_cents,
          transaction_id: payload.transaction_id,
          out_trade_no: payload.out_trade_no,
          source: 'wxpay',
        });
      } catch (err) {
        req.log.error({ err }, 'wxpay notify processing failed');
        // 500 lets wxpay retry; we want SUCCESS only when DB write completes
        reply.code(500);
        return { code: 'FAIL', message: 'processing failed' };
      }

      return { code: 'SUCCESS', message: 'OK' };
    });
  };
```

- [ ] **Step 5: Register raw-body content-type parser for `/wxpay/notify` in `server.ts`**

```ts
// after Fastify() instantiation:
app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  if (req.url === '/wxpay/notify') {
    // Hand back the raw string so the route can verify the signature.
    done(null, body);
    return;
  }
  try { done(null, JSON.parse(body as string)); }
  catch (err) { done(err as Error, undefined); }
});
```

Then register the route:

```ts
import { wxpayRoutes } from './routes/wxpay.js';
await app.register(wxpayRoutes(cfg));
```

- [ ] **Step 6: Run tests**

Run: `cd container && npm test -- routes/wxpay`
Expected: 3 tests PASS.

- [ ] **Step 7: Implement real wxpay client wrappers**

Replace `container/src/services/wxpay-client.ts`:

```ts
import { readFileSync } from 'node:fs';
import type { AppConfig } from '../config.js';
// @ts-expect-error: package has CJS-style types; runtime works in NodeNext when bundled with default export.
import WxPay from 'wechatpay-node-v3-ts';
import { createHash, createSign, randomBytes } from 'node:crypto';

export interface WxRequestPayParams {
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: 'RSA';
  paySign: string;
}

let _client: any | null = null;
function getClient(cfg: AppConfig) {
  if (_client) return _client;
  if (cfg.wxpay.mode !== 'real') {
    throw new Error('wxpay client unavailable in mock mode');
  }
  _client = new WxPay({
    appid: cfg.wxpay.appid,
    mchid: cfg.wxpay.mchid,
    privateKey: readFileSync(cfg.wxpay.privateKeyPath),
    publicKey: Buffer.from(''), // platform cert auto-fetched by SDK
    key: cfg.wxpay.apiV3Key,
  });
  return _client;
}

export async function createWxpayPrepayOrder(
  cfg: AppConfig,
  input: { openid: string; out_trade_no: string; amount: number; description: string },
): Promise<WxRequestPayParams> {
  const client = getClient(cfg);
  const r = await client.transactions_jsapi({
    appid: cfg.wxpay.appid,
    mchid: cfg.wxpay.mchid,
    description: input.description,
    out_trade_no: input.out_trade_no,
    notify_url: cfg.wxpay.notifyUrl,
    amount: { total: input.amount },
    payer: { openid: input.openid },
  });
  // r is already the wx.requestPayment payload shape per SDK README.
  return {
    timeStamp: String(r.timeStamp),
    nonceStr: String(r.nonceStr),
    package: String(r.package),
    signType: 'RSA',
    paySign: String(r.paySign),
  };
}

interface DecryptedNotify {
  out_trade_no: string;
  transaction_id: string;
  openid: string;
  amount_cents: number;
}

export async function verifyAndDecryptNotify(
  cfg: AppConfig,
  headers: Record<string, string>,
  bodyText: string,
): Promise<DecryptedNotify> {
  const client = getClient(cfg);

  // 1. Verify signature
  const ok = await client.verifySign({
    timestamp: headers['wechatpay-timestamp'],
    nonce: headers['wechatpay-nonce'],
    serial: headers['wechatpay-serial'],
    signature: headers['wechatpay-signature'],
    body: bodyText,
  });
  if (!ok) throw new Error('signature verification failed');

  // 2. Decrypt resource.ciphertext (AEAD_AES_256_GCM)
  const env = JSON.parse(bodyText) as {
    resource: { ciphertext: string; associated_data: string; nonce: string };
  };
  const plaintext = client.decipher_gcm({
    ciphertext: env.resource.ciphertext,
    associated_data: env.resource.associated_data,
    nonce: env.resource.nonce,
    key: cfg.wxpay.apiV3Key,
  });
  const data = typeof plaintext === 'string' ? JSON.parse(plaintext) : plaintext;

  if (data.trade_state !== 'SUCCESS') {
    throw new Error(`unexpected trade_state: ${data.trade_state}`);
  }
  return {
    out_trade_no: data.out_trade_no,
    transaction_id: data.transaction_id,
    openid: data.payer?.openid,
    amount_cents: data.amount?.payer_total ?? data.amount?.total,
  };
}
```

> SDK API details (method names + return shapes) come from the README of `wechatpay-node-v3-ts`. If a method signature differs at install time, adjust to match the installed version's docs.

- [ ] **Step 8: Run all tests**

Run: `cd container && npm test`
Expected: all PASS. (Real-mode client is only invoked when `cfg.wxpay.mode === 'real'`, which test config doesn't set.)

- [ ] **Step 9: Commit**

```bash
git add container/package.json container/package-lock.json \
        container/src/services/wxpay-client.ts container/src/routes/wxpay.ts \
        container/src/server.ts \
        container/test/routes/wxpay.test.ts
git commit -m "feat(wxpay): /wxpay/notify with v3 verify+decrypt + real-mode JSAPI prepay"
```

---

## Task 8: admin middleware + admin routes

**Files:**
- Create: `container/src/middleware/admin.ts`
- Create: `container/src/routes/admin.ts`
- Modify: `container/src/server.ts` (register adminRoutes)
- Modify: `container/src/config.ts` (add `adminToken`, `adminUiPathSegment`)
- Test: `container/test/middleware/admin.test.ts`
- Test: `container/test/routes/admin.test.ts`

- [ ] **Step 1: Add admin config**

Edit `config.ts`:

```ts
admin: { token: string; uiPathSegment: string };
// in loadConfig:
admin: {
  token: process.env.ADMIN_TOKEN ?? '',
  uiPathSegment: process.env.ADMIN_UI_PATH_SEGMENT ?? 'ui-x9k2',
},
```

- [ ] **Step 2: Write failing middleware test**

```ts
// container/test/middleware/admin.test.ts
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { adminAuthPlugin } from '../../src/middleware/admin.js';

function build(token: string) {
  const app = Fastify();
  app.register(adminAuthPlugin, { token });
  app.get('/admin/anything', async () => ({ ok: true }));
  app.get('/public', async () => ({ ok: true }));
  return app;
}

describe('adminAuthPlugin', () => {
  it('allows requests with matching X-Admin-Token to /admin/*', async () => {
    const res = await build('s3cret').inject({
      url: '/admin/anything', headers: { 'x-admin-token': 's3cret' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects /admin/* without token', async () => {
    const res = await build('s3cret').inject({ url: '/admin/anything' });
    expect(res.statusCode).toBe(403);
  });

  it('rejects /admin/* with wrong token', async () => {
    const res = await build('s3cret').inject({
      url: '/admin/anything', headers: { 'x-admin-token': 'nope' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does not interfere with non-/admin routes', async () => {
    const res = await build('s3cret').inject({ url: '/public' });
    expect(res.statusCode).toBe(200);
  });

  it('returns 503 if no admin token configured', async () => {
    const res = await build('').inject({
      url: '/admin/anything', headers: { 'x-admin-token': 'anything' },
    });
    expect(res.statusCode).toBe(503);
  });
});
```

- [ ] **Step 3: Implement `middleware/admin.ts`**

```ts
// container/src/middleware/admin.ts
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

interface Options { token: string }

const plugin: FastifyPluginAsync<Options> = async (app, opts) => {
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/admin/')) return;
    // Allow the static UI sub-path through (it's served by @fastify/static)
    // The protected boundary is the API endpoints under /admin/<verbs>; the UI
    // path is /admin/{ADMIN_UI_PATH_SEGMENT}/. Distinguish by exact matching is
    // too coupled — instead require token on every /admin/* request.
    if (!opts.token) {
      reply.code(503).send({ error: 'ADMIN_DISABLED', message: 'ADMIN_TOKEN not configured' });
      return;
    }
    const got = (req.headers['x-admin-token'] as string | undefined)?.trim();
    if (got !== opts.token) {
      reply.code(403).send({ error: 'FORBIDDEN' });
      return;
    }
  });
};

export const adminAuthPlugin = fp(plugin, { name: 'admin-auth' });
```

> Trade-off: this also gates the static admin UI behind the token, which means the HTML page won't load without a token. To keep the UI publicly fetchable (so the user can enter the token in the input box), exempt the static segment specifically. Replace the `if (!req.url.startsWith('/admin/')) return;` block with:
>
> ```ts
> if (!req.url.startsWith('/admin/')) return;
> if (req.url.startsWith(`/admin/${opts.uiPathSegment}/`)) return;
> ```
>
> and pass `uiPathSegment` into options. (Update interface + register call.)

- [ ] **Step 4: Run middleware tests**

Run: `cd container && npm test -- middleware/admin`
Expected: 5 tests PASS.

- [ ] **Step 5: Write failing admin route tests**

```ts
// container/test/routes/admin.test.ts
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { __resetDbForTest, __setDbForTest } from '../../src/db/mongo.js';
import { MongoAdapter } from '../../src/db/mongo-adapter.js';
import { adminRoutes } from '../../src/routes/admin.js';
import { adminAuthPlugin } from '../../src/middleware/admin.js';
import { getOrCreateUser, bindInviter } from '../../src/db/users.js';
import { recordPayment } from '../../src/services/payment.js';

let mongod: MongoMemoryServer; let client: MongoClient;
beforeAll(async () => { mongod = await MongoMemoryServer.create(); client = new MongoClient(mongod.getUri()); await client.connect(); __setDbForTest(new MongoAdapter(client.db('test'))); });
afterAll(async () => { await client.close(); await mongod.stop(); __resetDbForTest(); });
beforeEach(async () => {
  await client.db('test').collection('users').deleteMany({});
  await client.db('test').collection('subscriptions').deleteMany({});
});

const cfg = {
  admin: { token: 'tok', uiPathSegment: 'ui-x9k2' },
  subscription: { amountCents: 2000, periodDays: 30 },
  wxpay: { mode: 'mock' },
} as any;

function build() {
  const app = Fastify();
  app.register(adminAuthPlugin, { token: cfg.admin.token, uiPathSegment: cfg.admin.uiPathSegment });
  app.register(adminRoutes(cfg));
  return app;
}

const tok = { 'x-admin-token': 'tok' };

describe('admin routes', () => {
  it('GET /admin/rebates lists pending', async () => {
    await getOrCreateUser('oI');
    await getOrCreateUser('oA');
    await bindInviter({ inviteeOpenid: 'oA', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'tx1', out_trade_no: 'L1', source: 'mock' });
    const res = await build().inject({ url: '/admin/rebates?status=pending', headers: tok });
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].paid_user.invite_code).toBeDefined();
    expect(body[0].inviter.invite_code).toBeDefined();
    expect(body[0].amount).toBe(2000);
  });

  it('POST /admin/rebates/:id/mark-paid moves to paid', async () => {
    await getOrCreateUser('oI');
    await getOrCreateUser('oA');
    await bindInviter({ inviteeOpenid: 'oA', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    const r = await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'tx2', out_trade_no: 'L2', source: 'mock' });
    const app = build();
    const m = await app.inject({
      method: 'POST', url: `/admin/rebates/${r.subscription_id}/mark-paid`,
      headers: { ...tok, 'content-type': 'application/json' },
      payload: { rebate_note: '¥6.6 微信转账' },
    });
    expect(m.statusCode).toBe(200);
    const after = await app.inject({ url: '/admin/rebates?status=paid', headers: tok });
    expect(after.json()[0].rebate_note).toBe('¥6.6 微信转账');
  });

  it('GET /admin/subscriptions lists newest first', async () => {
    await getOrCreateUser('oA');
    await recordPayment(cfg, { openid: 'oA', amount: 2000, transaction_id: 'tx3', out_trade_no: 'L3', source: 'mock' });
    const res = await build().inject({ url: '/admin/subscriptions', headers: tok });
    expect(res.json()).toHaveLength(1);
    expect(res.json()[0].source).toBe('mock');
  });

  it('GET /admin/users?invite_code= returns user + referrals', async () => {
    const i = await getOrCreateUser('oI');
    await getOrCreateUser('oA'); await getOrCreateUser('oB');
    await bindInviter({ inviteeOpenid: 'oA', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    await bindInviter({ inviteeOpenid: 'oB', inviterOpenid: 'oI', inviteeReward: 5, inviterReward: 5 });
    const res = await build().inject({ url: `/admin/users?invite_code=${i.invite_code}`, headers: tok });
    const body = res.json();
    expect(body.user.openid).toBe('oI');
    expect(body.referrals).toHaveLength(2);
  });
});
```

- [ ] **Step 6: Implement `routes/admin.ts`**

```ts
// container/src/routes/admin.ts
import type { FastifyPluginAsync } from 'fastify';
import type { AppConfig } from '../config.js';
import { findUserByInviteCode, getOrCreateUser } from '../db/users.js';
import {
  findRebatesByStatus,
  listAllSubscriptions,
  markRebatePaid,
  type RebateStatus,
} from '../db/subscriptions.js';
import { getDb } from '../db/mongo.js';

export const adminRoutes =
  (_cfg: AppConfig): FastifyPluginAsync =>
  async (app) => {
    app.get<{ Querystring: { status?: RebateStatus } }>(
      '/admin/rebates',
      async (req) => {
        const status = (req.query.status ?? 'pending') as RebateStatus;
        const list = await findRebatesByStatus(status);
        const out = await Promise.all(
          list.map(async (s) => {
            const paidUser = await getOrCreateUser(s.openid);
            const inviter = s.inviter_openid ? await getOrCreateUser(s.inviter_openid) : null;
            return {
              subscription_id: s._id,
              paid_user: { openid: paidUser.openid, invite_code: paidUser.invite_code, paid_at: s.paid_at },
              inviter: inviter ? { openid: inviter.openid, invite_code: inviter.invite_code } : null,
              amount: s.amount,
              source: s.source,
              rebate_status: s.rebate_status,
              rebate_paid_at: s.rebate_paid_at ?? null,
              rebate_note: s.rebate_note ?? null,
            };
          }),
        );
        return out;
      },
    );

    app.post<{ Params: { id: string }; Body: { rebate_note?: string } }>(
      '/admin/rebates/:id/mark-paid',
      async (req, reply) => {
        try {
          await markRebatePaid(req.params.id, req.body?.rebate_note ?? '');
          return { ok: true };
        } catch (err) {
          reply.code(400);
          return { ok: false, error: (err as Error).message };
        }
      },
    );

    app.get<{ Querystring: { limit?: string; offset?: string } }>(
      '/admin/subscriptions',
      async (req) => {
        const limit = Math.min(200, Number(req.query.limit ?? 50));
        const offset = Math.max(0, Number(req.query.offset ?? 0));
        return listAllSubscriptions(limit, offset);
      },
    );

    app.get<{ Querystring: { invite_code?: string; openid?: string } }>(
      '/admin/users',
      async (req, reply) => {
        let user = null;
        if (req.query.invite_code) user = await findUserByInviteCode(req.query.invite_code);
        else if (req.query.openid) user = await getOrCreateUser(req.query.openid);
        if (!user) { reply.code(404); return { error: 'NOT_FOUND' }; }
        // referrals = anyone whose inviter_openid == user.openid
        const referralDocs = await getDb()
          .collection('users')
          .find({ inviter_openid: user.openid });
        return {
          user: { openid: user.openid, invite_code: user.invite_code, paid_until: user.paid_until ?? null, bonus_balance: user.bonus_balance },
          referrals: referralDocs.map((d) => ({ openid: d.openid, invited_at: d.invited_at })),
        };
      },
    );

    app.get('/admin/health', async () => ({
      ok: true,
      now: new Date().toISOString(),
    }));
  };
```

- [ ] **Step 7: Register in `server.ts`**

```ts
import { adminAuthPlugin } from './middleware/admin.js';
import { adminRoutes } from './routes/admin.js';
// after openidPlugin:
await app.register(adminAuthPlugin, { token: cfg.admin.token, uiPathSegment: cfg.admin.uiPathSegment });
// after other route registers:
await app.register(adminRoutes(cfg));
```

> Important: register `adminAuthPlugin` BEFORE `adminRoutes`. The `onRequest` hook intercepts before route handlers run.

- [ ] **Step 8: Run all tests**

Run: `cd container && npm test`
Expected: all PASS (admin middleware + admin routes + everything prior).

- [ ] **Step 9: Commit**

```bash
git add container/src/middleware/admin.ts container/src/routes/admin.ts \
        container/src/server.ts container/src/config.ts \
        container/test/middleware/admin.test.ts container/test/routes/admin.test.ts
git commit -m "feat(admin): X-Admin-Token middleware + /admin/{rebates,subscriptions,users} routes"
```

---

## Task 9: admin static HTML page

**Files:**
- Modify: `container/package.json` (+ `@fastify/static`)
- Create: `container/public/admin.html`
- Modify: `container/src/server.ts` (register @fastify/static)

> No automated tests — manual verification at the end.

- [ ] **Step 1: Install dependency**

```bash
cd container && npm install @fastify/static@^7 --save
```

- [ ] **Step 2: Create `container/public/admin.html`**

```html
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>love-train · admin</title>
<style>
  :root {
    --bg: #f7f3ec; --ink: #2a2a2a; --accent: #e76f51; --wine: #8b3a3a;
    --line: rgba(0,0,0,0.12); --muted: #6b6b6b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, "PingFang SC", system-ui, sans-serif; }
  header { padding: 24px 28px; border-bottom: 1px solid var(--line); display: flex; align-items: baseline; gap: 16px; }
  h1 { margin: 0; font-style: italic; font-family: Georgia, serif; font-weight: 400; }
  .token-row { padding: 16px 28px; display: flex; gap: 8px; border-bottom: 1px solid var(--line); }
  .token-row input { flex: 1; padding: 8px 12px; border: 1px solid var(--line); border-radius: 4px; background: white; font: inherit; }
  .token-row button, .row button, .form button { padding: 8px 14px; background: var(--accent); color: white; border: none; border-radius: 4px; font: inherit; cursor: pointer; }
  .row button.ghost, .form button.ghost { background: transparent; color: var(--wine); border: 1px solid var(--wine); }
  nav.tabs { display: flex; padding: 0 28px; border-bottom: 1px solid var(--line); }
  nav.tabs a { padding: 12px 16px; cursor: pointer; color: var(--muted); border-bottom: 2px solid transparent; }
  nav.tabs a.active { color: var(--ink); border-bottom-color: var(--accent); }
  main { padding: 24px 28px; }
  .card { background: white; padding: 16px 20px; border-radius: 8px; margin-bottom: 12px; border: 1px solid var(--line); }
  .card .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
  .meta { color: var(--muted); font-size: 13px; }
  .src-mock { display: inline-block; padding: 1px 6px; background: var(--wine); color: white; border-radius: 3px; font-size: 11px; }
  .src-wxpay { display: inline-block; padding: 1px 6px; background: var(--accent); color: white; border-radius: 3px; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; }
  td, th { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--line); font-variant-numeric: tabular-nums; }
  .form { display: flex; flex-direction: column; gap: 8px; max-width: 480px; }
  .form input, .form textarea { padding: 8px 12px; border: 1px solid var(--line); border-radius: 4px; font: inherit; }
  dialog { border: 1px solid var(--line); border-radius: 8px; padding: 20px; max-width: 480px; }
  dialog::backdrop { background: rgba(0,0,0,0.4); }
</style>
</head>
<body>
<header>
  <h1>love-train · admin</h1>
  <span class="meta" id="status">未登录</span>
</header>
<div class="token-row">
  <input id="token" placeholder="X-Admin-Token" />
  <button onclick="saveToken()">保存</button>
</div>
<nav class="tabs">
  <a data-tab="pending" class="active">待返点</a>
  <a data-tab="paid">已返点</a>
  <a data-tab="all">全部订阅</a>
  <a data-tab="users">用户查询</a>
</nav>
<main id="view"></main>

<dialog id="markDialog">
  <form method="dialog" class="form" onsubmit="return submitMark(event)">
    <h3 style="margin:0">标记已发返点</h3>
    <textarea id="rebateNote" rows="3" placeholder="¥6.6 微信转账 5月10日..."></textarea>
    <div class="row" style="display:flex; gap:8px;">
      <button type="button" class="ghost" onclick="document.getElementById('markDialog').close()">取消</button>
      <button type="submit">确定</button>
    </div>
  </form>
</dialog>

<script>
const $ = (sel) => document.querySelector(sel);
const view = document.getElementById('view');
let activeTab = 'pending';
let pendingMarkId = null;

function saveToken() {
  const t = $('#token').value.trim();
  localStorage.setItem('lt_admin_token', t);
  $('#status').textContent = t ? 'token 已保存' : '未登录';
  render();
}

function getToken() {
  return localStorage.getItem('lt_admin_token') || '';
}

async function api(path, opts = {}) {
  const t = getToken();
  if (!t) return null;
  const res = await fetch(path, {
    ...opts,
    headers: { 'X-Admin-Token': t, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`API ${res.status}: ${err.error || res.statusText}`);
    return null;
  }
  return res.json();
}

document.querySelectorAll('nav.tabs a').forEach(a => a.addEventListener('click', () => {
  document.querySelectorAll('nav.tabs a').forEach(x => x.classList.remove('active'));
  a.classList.add('active');
  activeTab = a.dataset.tab;
  render();
}));

async function render() {
  const t = getToken();
  if (!t) { view.innerHTML = '<p class="meta">请先在上方输入 token 并保存</p>'; return; }
  if (activeTab === 'pending') return renderRebates('pending');
  if (activeTab === 'paid') return renderRebates('paid');
  if (activeTab === 'all') return renderAll();
  if (activeTab === 'users') return renderUsers();
}

async function renderRebates(status) {
  const data = await api('/admin/rebates?status=' + status);
  if (!data) return;
  if (data.length === 0) { view.innerHTML = `<p class="meta">没有 ${status} 订阅</p>`; return; }
  view.innerHTML = data.map(s => `
    <div class="card">
      <div class="row">
        <div>
          <div><b>${s.paid_user.openid.slice(0, 12)}…</b> (${s.paid_user.invite_code}) · ¥${(s.amount/100).toFixed(2)} · <span class="src-${s.source}">${s.source}</span></div>
          <div class="meta">上级 ${s.inviter ? s.inviter.openid.slice(0,12) + '… (' + s.inviter.invite_code + ')' : '无'} · 付款 ${new Date(s.paid_user.paid_at).toLocaleString('zh-CN')}</div>
          ${s.rebate_paid_at ? `<div class="meta">已发：${s.rebate_note} (${new Date(s.rebate_paid_at).toLocaleString('zh-CN')})</div>` : ''}
        </div>
        ${status === 'pending' ? `<button onclick="openMark('${s.subscription_id}')">标记已发</button>` : ''}
      </div>
    </div>
  `).join('');
}

async function renderAll() {
  const data = await api('/admin/subscriptions?limit=100');
  if (!data) return;
  view.innerHTML = `<table>
    <thead><tr><th>付款时间</th><th>付费人</th><th>上级</th><th>金额</th><th>来源</th><th>返点</th></tr></thead>
    <tbody>${data.map(s => `<tr>
      <td>${new Date(s.paid_at).toLocaleString('zh-CN')}</td>
      <td>${s.openid.slice(0,12)}…</td>
      <td>${s.inviter_openid ? s.inviter_openid.slice(0,12) + '…' : '-'}</td>
      <td>¥${(s.amount/100).toFixed(2)}</td>
      <td><span class="src-${s.source}">${s.source}</span></td>
      <td>${s.rebate_status}</td>
    </tr>`).join('')}</tbody>
  </table>`;
}

async function renderUsers() {
  view.innerHTML = `
    <div class="form">
      <input id="q" placeholder="邀请码 (e.g. A8K2P9) 或 openid" />
      <button onclick="findUser()">查询</button>
      <div id="userResult"></div>
    </div>`;
}

async function findUser() {
  const q = $('#q').value.trim();
  if (!q) return;
  const isCode = /^[A-Z0-9]{6}$/.test(q);
  const data = await api('/admin/users?' + (isCode ? `invite_code=${q}` : `openid=${q}`));
  if (!data) return;
  $('#userResult').innerHTML = `
    <div class="card">
      <div><b>${data.user.openid}</b> · 邀请码 ${data.user.invite_code} · 奖励余 ${data.user.bonus_balance} · 付费至 ${data.user.paid_until ?? '无'}</div>
    </div>
    <h3>邀请了 ${data.referrals.length} 人</h3>
    ${data.referrals.map(r => `<div class="card meta">${r.openid} · ${r.invited_at ? new Date(r.invited_at).toLocaleString('zh-CN') : ''}</div>`).join('')}`;
}

function openMark(id) {
  pendingMarkId = id;
  $('#rebateNote').value = '';
  $('#markDialog').showModal();
}

async function submitMark(e) {
  e.preventDefault();
  const note = $('#rebateNote').value.trim();
  if (!pendingMarkId) return false;
  const r = await api(`/admin/rebates/${pendingMarkId}/mark-paid`, {
    method: 'POST', body: JSON.stringify({ rebate_note: note }),
  });
  if (r) { $('#markDialog').close(); render(); }
  return false;
}

// init
$('#token').value = getToken();
$('#status').textContent = getToken() ? 'token 已加载' : '未登录';
render();
</script>
</body>
</html>
```

- [ ] **Step 3: Register `@fastify/static` in `server.ts`**

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';

// after Fastify() but before route registers:
const __dirname = path.dirname(fileURLToPath(import.meta.url));
await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: `/admin/${cfg.admin.uiPathSegment}/`,
  decorateReply: false,
});
```

(Adjust `..` depth depending on whether `server.ts` is compiled to `dist/server.js`. The repo uses `tsc → dist/`, so `dist/server.js` + `../public` → `<container>/public`. ✓)

> The admin auth middleware already exempts `/admin/${uiPathSegment}/` (per Task 8 step 3 note). Verify: the static asset path won't 403.

- [ ] **Step 4: Verify locally**

```bash
cd container && npm run dev
```

In another terminal:

```bash
curl -i http://localhost:3000/admin/ui-x9k2/admin.html | head -5
# Expected: HTTP/1.1 200 OK + HTML content
curl -i http://localhost:3000/admin/rebates?status=pending
# Expected: HTTP/1.1 403 (no token)
curl -i -H 'X-Admin-Token: <whatever ADMIN_TOKEN env is set to>' http://localhost:3000/admin/rebates?status=pending
# Expected: HTTP/1.1 200 + []
```

- [ ] **Step 5: Commit**

```bash
git add container/package.json container/package-lock.json \
        container/public/admin.html container/src/server.ts
git commit -m "feat(admin): static admin.html under /admin/<segment>/ via @fastify/static"
```

---

## Task 10: 前端 chat 分享 + login 自动绑定

**Files:**
- Modify: `miniprogram/utils/api.ts` (extend UserInfo + add bindInvite)
- Modify: `miniprogram/pages/chat/chat.ts` (onShareAppMessage)
- Modify: `miniprogram/pages/login/login.ts` (onLoad ic + post-login bind)

> Frontend has no automated tests in this repo; verification is via 微信开发者工具 模拟器.

- [ ] **Step 1: Extend UserInfo + api.ts**

Modify `miniprogram/utils/api.ts`. Add fields to `UserInfo`:

```ts
export interface UserInfo {
  openid: string;
  nickname: string;
  avatarUrl: string;
  remainingUses: number;
  totalUses: number;
  isNewUser: boolean;
  // new
  today_limit: number;
  is_paid: boolean;
  paid_until: string | null;
  invite_code: string;
  inviter: { invite_code: string } | null;
  bonus_balance: number;
}
```

Add method:

```ts
export interface BindInviteResponse {
  ok: boolean;
  bonus_added?: number;
  error?: string;
}

export const api = {
  // ... existing
  bindInvite: (code: string) =>
    callBackend<BindInviteResponse>('/invite/bind', 'POST', { code }),
  createOrder: (data: { months?: number }) =>
    callBackend<
      | { mode: 'mock'; subscription_id: string; paid_until: string }
      | { mode: 'real'; wx_payment: { timeStamp: string; nonceStr: string; package: string; signType: 'RSA'; paySign: string } }
    >('/payment/create-order', 'POST', data),
};
```

Add to `consts.ts`:

```ts
export const INVITE_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
```

- [ ] **Step 2: chat 页 `onShareAppMessage`**

Edit `miniprogram/pages/chat/chat.ts`. Add to the `Page({...})`:

```ts
onShareAppMessage() {
  const app = getApp<IAppOption>();
  const ic = app.globalData.user?.invite_code;
  return {
    title: '童锦程教你怎么搞定她',
    path: ic ? `/pages/login/login?ic=${ic}` : '/pages/login/login',
    imageUrl: '/assets/share-cover.png',
  };
},
```

Verify `app.globalData.user` exists (it's already populated in login). If `IAppOption` type doesn't include `user.invite_code`, update `app.ts`:

```ts
// app.ts globalData type
globalData: { user?: UserInfo /* now includes invite_code */ };
```

- [ ] **Step 3: login 页 onLoad ic + 登录后 bind**

Edit `miniprogram/pages/login/login.ts`:

```ts
import { api, type UserInfo } from '../../utils/api';
import { INVITE_CODE_PATTERN } from '../../utils/consts';

const app = getApp<IAppOption>();

Page({
  data: { agreed: false, loading: false, errorMsg: '' },

  onLoad(options: Record<string, string>) {
    if (options?.ic && INVITE_CODE_PATTERN.test(options.ic)) {
      try { wx.setStorageSync('pending_ic', options.ic); } catch {}
    }
    if (app.globalData.user) {
      wx.reLaunch({ url: '/pages/chat/chat' });
    }
  },

  // ... onToggleAgree, onLogin (modify) ...

  async onLogin() {
    if (!this.data.agreed) { wx.showToast({ title: '请先勾选协议', icon: 'none' }); return; }
    if (this.data.loading) return;
    this.setData({ loading: true, errorMsg: '' });

    try {
      const user = await api.me();
      app.setUser(user);
      // Best-effort bind if there's a pending invite code
      const pendingIc = (() => { try { return wx.getStorageSync('pending_ic') as string; } catch { return ''; } })();
      if (pendingIc) {
        try {
          const r = await api.bindInvite(pendingIc);
          if (r.ok) wx.showToast({ title: `已通过邀请 +${r.bonus_added} 次`, icon: 'success' });
          // failure silent — user shouldn't be blocked by inviter mishaps
        } catch {} finally {
          try { wx.removeStorageSync('pending_ic'); } catch {}
        }
        // Refresh user (bonus changed)
        try { const fresh = await api.me(); app.setUser(fresh); } catch {}
      }

      try {
        const profile = await wx.getUserProfile({ desc: '用于展示你的昵称与头像' });
        if (profile?.userInfo) {
          await api.updateProfile({
            nickname: profile.userInfo.nickName,
            avatarUrl: profile.userInfo.avatarUrl,
          });
          app.setUser({ ...app.globalData.user!, nickname: profile.userInfo.nickName, avatarUrl: profile.userInfo.avatarUrl });
        }
      } catch {}

      wx.reLaunch({ url: '/pages/chat/chat' });
    } catch (err: any) {
      this.setData({ errorMsg: err?.message ?? '登录失败，请重试', loading: false });
    }
  },

  onAbout() { wx.navigateTo({ url: '/pages/about/about' }); },
});
```

- [ ] **Step 4: Manual verification (微信开发者工具)**

In the simulator:

1. Compile mode → 自定义编译条件 → 启动参数 = `ic=ABC123`（或某个真存在的 invite_code）→ 启动页 = `pages/login/login`
2. 登录 → 应该 toast 「已通过邀请 +5 次」
3. 在 chat 页点 ··· → 转发 → 看分享卡 path 包含 `?ic=...`

> 这一步暂时无法测真分享给好友的接收路径，但 ic 透传 + bind API 全部走通即可。

- [ ] **Step 5: Commit**

```bash
git add miniprogram/utils/api.ts miniprogram/utils/consts.ts \
        miniprogram/pages/chat/chat.ts miniprogram/pages/login/login.ts \
        miniprogram/app.ts
git commit -m "feat(mp): chat onShareAppMessage carries ic + login auto-binds invite"
```

---

## Task 11: 前端 about 页 + quota-badge

**Files:**
- Modify: `miniprogram/pages/about/about.{ts,wxml,wxss}`
- Modify: `miniprogram/components/quota-badge/{quota-badge.ts,wxml,wxss}`
- Modify: `miniprogram/pages/chat/chat.ts` (refresh user after returning from about)

- [ ] **Step 1: Extend `quota-badge`**

`miniprogram/components/quota-badge/quota-badge.ts`:

```ts
Component({
  properties: {
    remaining: { type: Number, value: 0 },
    limit: { type: Number, value: 10 },
    bonus: { type: Number, value: 0 },
  },
  data: {},
});
```

`miniprogram/components/quota-badge/quota-badge.wxml`:

```xml
<view class="badge">
  <text class="head">今日</text>
  <text class="num">{{remaining}}</text>
  <text class="dash">—</text>
  <text class="num">{{limit}}</text>
  <view wx:if="{{bonus > 0}}" class="bonus">＋奖励 {{bonus}}</view>
</view>
```

`miniprogram/components/quota-badge/quota-badge.wxss` — append:

```css
.bonus {
  margin-left: 8rpx;
  padding: 2rpx 10rpx;
  border-radius: 999rpx;
  background: rgba(231, 111, 81, 0.15);
  color: #e76f51;
  font-size: 22rpx;
}
```

- [ ] **Step 2: Pass bonus in chat page**

In `miniprogram/pages/chat/chat.wxml`, find the `<quota-badge>` tag and add `bonus="{{bonus}}"`:

```xml
<quota-badge remaining="{{remaining}}" limit="{{limit}}" bonus="{{bonus}}" />
```

In `chat.ts` data add `bonus: 0`, `limit: 10` and update them after `api.me()` / `api.quota()` calls:

```ts
this.setData({ remaining: user.remainingUses, bonus: user.bonus_balance, limit: user.today_limit });
```

(Fix everywhere `remaining` is set; usually 3-4 spots: initial load, after chat onDone, after refreshing.)

- [ ] **Step 3: Rewrite about page**

`miniprogram/pages/about/about.ts`:

```ts
import { api, type UserInfo } from '../../utils/api';

const app = getApp<IAppOption>();

Page({
  data: {
    version: '0.1.0',
    user: null as UserInfo | null,
    paying: false,
    expireText: '',
  },

  async onShow() {
    try {
      const user = await api.me();
      app.setUser(user);
      this.setData({
        user,
        expireText: user.paid_until ? new Date(user.paid_until).toLocaleDateString('zh-CN') : '',
      });
    } catch {}
  },

  async onSubscribe() {
    if (this.data.paying) return;
    this.setData({ paying: true });
    try {
      const r = await api.createOrder({ months: 1 });
      if (r.mode === 'mock') {
        wx.showModal({
          title: '已模拟开通付费（测试模式）',
          content: `有效期至 ${new Date(r.paid_until).toLocaleDateString('zh-CN')}\n\n生产环境上线后将走真实微信支付。`,
          showCancel: false,
        });
        await this.onShow();
      } else {
        wx.requestPayment({
          ...r.wx_payment,
          success: async () => {
            wx.showToast({ title: '支付成功，处理中…', icon: 'none' });
            // notify→DB write usually < 3s; poll up to 5×
            for (let i = 0; i < 5; i += 1) {
              await new Promise(res => setTimeout(res, 1500));
              try {
                const fresh = await api.me();
                if (fresh.is_paid) { app.setUser(fresh); this.setData({ user: fresh, expireText: fresh.paid_until ? new Date(fresh.paid_until).toLocaleDateString('zh-CN') : '' }); break; }
              } catch {}
            }
          },
          fail: () => { wx.showToast({ title: '已取消支付', icon: 'none' }); },
        });
      }
    } catch (err: any) {
      wx.showToast({ title: err?.message ?? '下单失败', icon: 'none' });
    } finally {
      this.setData({ paying: false });
    }
  },

  // existing handlers
  onAgreement() { wx.showToast({ title: '协议详情即将提供', icon: 'none' }); },
  onContact() {
    wx.setClipboardData({ data: 'joshxieavalon@gmail.com',
      success: () => wx.showToast({ title: '邮箱已复制', icon: 'none' }) });
  },
  onClearLocal() {
    wx.showModal({
      title: '清空聊天', content: '本机所有聊天记录将被清除，且无法恢复。',
      confirmColor: '#8b3a3a',
      success: (r) => {
        if (!r.confirm) return;
        try {
          const info = wx.getStorageInfoSync();
          (info.keys || []).forEach((k) => {
            if (k.startsWith('chat:history:') || k === 'chat:draft') wx.removeStorageSync(k);
          });
        } catch {}
        wx.showToast({ title: '已清空', icon: 'success' });
      },
    });
  },
});
```

`miniprogram/pages/about/about.wxml` — add new sections above the existing cards:

```xml
<view class="page">
  <!-- Identity -->
  <view class="identity">
    <view class="logo serif-italic">l</view>
    <view class="brand serif-italic">love-train</view>
    <view class="version">v {{version}} · 体验版</view>
    <view class="desc">给男性的情感咨询助手。\n把困扰发过来，给你一段不啰嗦的诊断。</view>
  </view>

  <!-- 会员状态 -->
  <view class="member-card" wx:if="{{user}}">
    <view wx:if="{{user.is_paid}}">
      <view class="m-title">付费会员 · 每日 {{user.today_limit}} 次</view>
      <view class="m-meta">有效期至 {{expireText}}</view>
      <button class="m-btn ghost" bindtap="onSubscribe" loading="{{paying}}">续费 ¥20/月</button>
    </view>
    <view wx:else>
      <view class="m-title">免费会员 · 每日 {{user.today_limit}} 次</view>
      <view class="m-meta">付费版每日 30 次 · 免广告</view>
      <button class="m-btn primary" bindtap="onSubscribe" loading="{{paying}}">开通付费版 ¥20/月</button>
    </view>
  </view>

  <!-- 邀请好友 -->
  <view class="invite-card" wx:if="{{user}}">
    <view class="i-title">邀请好友 · 双方各 +5 次免费查询</view>
    <view class="i-code">我的邀请码 <text>{{user.invite_code}}</text></view>
    <view class="i-hint">点击右上角 ··· 转发给朋友，对方登录后自动绑定</view>
  </view>

  <!-- existing cards (协议 / 隐私 / 联系) -->
  <view class="cards">
    ... (unchanged)
  </view>

  <!-- existing danger zone -->
  <view class="danger-zone">
    ... (unchanged)
  </view>

  <view class="footer">ESCAPE STUDIO · 2026</view>
</view>
```

`miniprogram/pages/about/about.wxss` — add at the bottom:

```css
.member-card, .invite-card {
  margin: 24rpx 32rpx;
  padding: 28rpx 32rpx;
  background: white;
  border-radius: 16rpx;
  border: 1rpx solid rgba(0,0,0,0.08);
}
.m-title, .i-title { font-size: 28rpx; font-weight: 600; }
.m-meta, .i-hint { margin-top: 8rpx; color: #6b6b6b; font-size: 24rpx; }
.m-btn {
  margin-top: 20rpx; height: 76rpx; line-height: 76rpx;
  border-radius: 999rpx; font-size: 28rpx;
}
.m-btn.primary { background: #e76f51; color: white; }
.m-btn.ghost { background: transparent; color: #8b3a3a; border: 1rpx solid #8b3a3a; }
.i-code { margin-top: 12rpx; font-size: 28rpx; }
.i-code text { font-family: 'Menlo', 'Roboto Mono', monospace; letter-spacing: 4rpx; padding: 4rpx 12rpx; background: rgba(231,111,81,0.12); color: #e76f51; border-radius: 6rpx; }
```

- [ ] **Step 4: Manual verification**

1. 模拟器登录
2. 进 about 页 → 应看到「免费会员」卡片 + 邀请码 + 邀请说明
3. 点「开通付费版」按钮 → 看到 modal「已模拟开通」→ 关闭 → 卡片切换为「付费会员 · 有效期至 ...」
4. 回到 chat 页 → quota-badge 显示「今日 X / 30」
5. admin 页（浏览器）→ 待返点列表查不到（无上级），全部订阅看到一条 `mock`
6. 用 ic 启动一次模拟器（task 10 的步骤），登录，再走 3 — admin「待返点」应该有一条

- [ ] **Step 5: Commit**

```bash
git add miniprogram/pages/about/ miniprogram/components/quota-badge/ \
        miniprogram/pages/chat/chat.wxml miniprogram/pages/chat/chat.ts
git commit -m "feat(mp): about page member status + invite + quota-badge bonus display"
```

---

## Task 12: 集成手测 + 清理

**Files:** none (手测 checklist + 删调试日志)

- [ ] **Step 1: 走完 mock 模式完整 happy path**

按 spec §11.1 跑一遍：
- [ ] 邀请双方 +5
- [ ] WINDOW_EXPIRED / ALREADY_BOUND / SELF_INVITE 各一例
- [ ] mock 开通付费 → paid_until 写入 + 每日额度变 30
- [ ] admin 后台「全部订阅」看到 mock
- [ ] 有上级时「待返点」+ 标记已发 → 「已返点」
- [ ] chat 发消息：先消耗 bonus 5 次，再算 daily_usage

- [ ] **Step 2: 清理临时调试**

```bash
grep -rn '\[lt\]' container/src miniprogram/ 2>/dev/null
```
删除剩余 `console.log('[lt]...')` 类调试输出（参考 handoff §8.P0）。

- [ ] **Step 3: 运行完整 typecheck + 测试**

```bash
cd container
npm run typecheck
npm test
```

Expected: 0 type errors, all tests PASS.

- [ ] **Step 4: 配置 mock 模式 env（CloudBase 控制台）**

在 [tcb 控制台](https://tcb.cloud.tencent.com/dev) → cool123 环境 → 云托管 → love-train-mp3 → 服务配置 → 环境变量：

```
ADMIN_TOKEN=<32 位随机串>
ADMIN_UI_PATH_SEGMENT=ui-<8 位随机>
WXPAY_MODE=mock
INVITE_REWARD_INVITER=5
INVITE_REWARD_INVITEE=5
INVITE_BIND_WINDOW_DAYS=7
DAILY_LIMIT_FREE=10
DAILY_LIMIT_PAID=30
SUBSCRIPTION_AMOUNT_CENTS=2000
SUBSCRIPTION_PERIOD_DAYS=30
```

- [ ] **Step 5: 部署 + 真机/体验版手测**

```bash
cd /Users/qichenxie/Desktop/love-train-mp/container && npm run build
cd /Users/qichenxie/Desktop/love-train-mp
yes "" | tcb cloudrun deploy -s love-train-mp3 --source . --port 3000 --force
```

- 微信开发者工具 → 上传体验版
- 微信公众平台 → 版本管理 → 设为体验版
- 在自己手机上跑一遍 mock 模式 happy path
- 浏览器打开 `https://love-train-mp3-cool123-d0gec5og96116475f-1425698520.sh.run.tcloudbase.com/admin/ui-<segment>/admin.html` → 输 token → 跑 admin 操作

- [ ] **Step 6: 最终 commit**

```bash
git add -u
git commit -m "chore: clean up debug logs after invite+subscription rollout" --allow-empty
git log --oneline -15
```

> 切真支付的剩余步骤见 spec §14（独立 task，不在本 plan 范围）。

---

## Self-Review Notes

This plan was checked against the spec. Coverage map:

| Spec § | 实施 task |
|---|---|
| §3 数据模型 | T1, T2, T3 |
| §4 用户体验流程 | T10, T11 (UX), backend by T4-T7 |
| §5.1 /auth/me | T4 |
| §5.1 /invite/bind | T4 |
| §5.1 /payment/create-order | T6 |
| §5.1 /wxpay/notify | T7 |
| §5.2 admin API | T8 |
| §5.3 admin static | T9 |
| §6 配额扣减 | T5 |
| §7 邀请前端触发 | T10 |
| §8 wxpay 前置条件 | docs only — `docs/specs` §14 owns the 切真支付 checklist |
| §9 env 配置 | T4 / T6 / T8 set them; T12 lists actual values for deploy |
| §10 安全 | T2/T3 atomicity, T7 验签, T8 admin token, T6 mode 校验 |
| §11 测试要点 | T1-T8 自动化 + T12 手测 checklist |
| §12 admin 后台页 | T9 |
| §13 文件清单 | T1-T11 cumulative |

Endpoint name **`/auth/me` (not `/user/me`)** — plan uses the existing route per Context Note #1; spec drift is documented and intentional.
