import { api } from '../../utils/api';

const app = getApp<IAppOption>();

Page({
  data: {
    agreed: false,
    loading: false,
    errorMsg: '',
  },

  onLoad() {
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

      try {
        const profile = await wx.getUserProfile({ desc: '用于展示你的昵称与头像' });
        if (profile?.userInfo) {
          await api.updateProfile({
            nickname: profile.userInfo.nickName,
            avatarUrl: profile.userInfo.avatarUrl,
          });
          app.setUser({
            ...user,
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
