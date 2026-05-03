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
