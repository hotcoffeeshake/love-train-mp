import { api, type UserInfo } from '../../utils/api';

const app = getApp<IAppOption>();

Page({
  data: {
    version: '0.1.0',
    user: null as UserInfo | null,
    expireText: '',
  },

  async onShow() {
    try {
      const user = await api.me();
      app.setUser(user);
      this.setData({
        user,
        expireText: user.paid_until
          ? new Date(user.paid_until).toLocaleDateString('zh-CN')
          : '',
      });
    } catch {
      /* silent */
    }
  },

  onOpenSubscribe() {
    wx.navigateTo({ url: '/pages/subscribe/subscribe' });
  },

  onAgreement() {
    wx.showToast({ title: '协议详情即将提供', icon: 'none' });
  },

  onContact() {
    wx.setClipboardData({
      data: 'UnheardBili',
      success: () =>
        wx.showToast({ title: '微信号已复制：UnheardBili', icon: 'none' }),
    });
  },

  onClearLocal() {
    wx.showModal({
      title: '清空聊天',
      content: '本机所有聊天记录将被清除，且无法恢复。',
      confirmColor: '#8b3a3a',
      success: (r) => {
        if (!r.confirm) return;
        try {
          const info = wx.getStorageInfoSync();
          (info.keys || []).forEach((k) => {
            if (k.startsWith('chat:history:') || k === 'chat:draft') {
              wx.removeStorageSync(k);
            }
          });
        } catch {
          /* ignore */
        }
        wx.showToast({ title: '已清空', icon: 'success' });
      },
    });
  },
});
