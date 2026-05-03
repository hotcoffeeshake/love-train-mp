import { api } from '../../utils/api';
import { INVITE_CODE_PATTERN } from '../../utils/consts';

const app = getApp<IAppOption>();

Page({
  data: {
    agreed: false,
    loading: false,
    errorMsg: '',
  },

  onLoad(options: Record<string, string>) {
    if (options?.ic && INVITE_CODE_PATTERN.test(options.ic)) {
      try { wx.setStorageSync('pending_ic', options.ic); } catch {}
    }
    if (app.globalData.user) {
      wx.reLaunch({ url: '/pages/chat/chat' });
    }
  },

  onToggleAgree() {
    this.setData({ agreed: !this.data.agreed });
  },

  async onLogin() {
    if (!this.data.agreed) {
      wx.showToast({ title: '请先勾选协议', icon: 'none' });
      return;
    }
    if (this.data.loading) return;
    this.setData({ loading: true, errorMsg: '' });

    try {
      const user = await api.me();
      app.setUser(user);

      // Best-effort bind if there's a pending invite code
      const pendingIc = (() => {
        try { return wx.getStorageSync('pending_ic') as string; } catch { return ''; }
      })();
      if (pendingIc) {
        try {
          const r = await api.bindInvite(pendingIc);
          if (r.ok) {
            wx.showToast({ title: `已通过邀请 +${r.bonus_added} 次`, icon: 'success' });
          }
        } catch {
          // failure silent — user shouldn't be blocked by inviter mishaps
        } finally {
          try { wx.removeStorageSync('pending_ic'); } catch {}
        }
        // Refresh user (bonus changed)
        try {
          const fresh = await api.me();
          app.setUser(fresh);
        } catch {}
      }

      try {
        const profile = await wx.getUserProfile({ desc: '用于展示你的昵称与头像' });
        if (profile?.userInfo) {
          await api.updateProfile({
            nickname: profile.userInfo.nickName,
            avatarUrl: profile.userInfo.avatarUrl,
          });
          app.setUser({
            ...app.globalData.user!,
            nickname: profile.userInfo.nickName,
            avatarUrl: profile.userInfo.avatarUrl,
          });
        }
      } catch {
        // 用户拒绝授权，继续流程
      }

      wx.reLaunch({ url: '/pages/chat/chat' });
    } catch (err: any) {
      this.setData({
        errorMsg: err?.message ?? '登录失败，请重试',
        loading: false,
      });
    }
  },

  onAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },
});
