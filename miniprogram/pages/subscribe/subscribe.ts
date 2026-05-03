import { api, type UserInfo } from '../../utils/api';

const app = getApp<IAppOption>();

Page({
  data: {
    user: null as UserInfo | null,
    paying: false,
    expireText: '',
    freeLimit: 10,
    paidLimit: 30,
    priceYuan: 20,
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
    } catch (err: any) {
      wx.showToast({ title: err?.message ?? '加载失败', icon: 'none' });
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
                  wx.showToast({ title: '开通成功', icon: 'success' });
                  break;
                }
              } catch {
                /* ignore */
              }
            }
          },
          fail: () => {
            wx.showToast({ title: '已取消支付', icon: 'none' });
          },
        });
      }
    } catch (err: any) {
      wx.showToast({ title: err?.message ?? '下单失败', icon: 'none' });
    } finally {
      this.setData({ paying: false });
    }
  },
});
