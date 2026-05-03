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
        expireText: user.paid_until
          ? new Date(user.paid_until).toLocaleDateString('zh-CN')
          : '',
      });
    } catch {
      // 静默失败：保留老值
    }
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
              await new Promise((res) => setTimeout(res, 1500));
              try {
                const fresh = await api.me();
                if (fresh.is_paid) {
                  app.setUser(fresh);
                  this.setData({
                    user: fresh,
                    expireText: fresh.paid_until
                      ? new Date(fresh.paid_until).toLocaleDateString('zh-CN')
                      : '',
                  });
                  break;
                }
              } catch {
                /* keep polling */
              }
            }
          },
          fail: () => {
            wx.showToast({ title: '已取消支付', icon: 'none' });
          },
        });
      }
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? '下单失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ paying: false });
    }
  },

  onAgreement() {
    wx.showToast({ title: '协议详情即将提供', icon: 'none' });
  },

  onContact() {
    wx.setClipboardData({
      data: 'joshxieavalon@gmail.com',
      success: () => wx.showToast({ title: '邮箱已复制', icon: 'none' }),
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
