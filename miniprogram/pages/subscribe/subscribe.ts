import { api, type UserInfo } from '../../utils/api';

const app = getApp<IAppOption>();

/**
 * 当前阶段：微信支付商户号未到位，付费走"联系运营手动开通"。
 * 用户在此页能拿到自己的开通码（= invite_code），告诉运营 + 转账后运营 curl /admin/grant-paid
 * 开通。这版 UI 不调 api.createOrder（mock 升级会让所有用户白嫖）。
 */
Page({
  data: {
    user: null as UserInfo | null,
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
    } catch (err: unknown) {
      const msg = (err as { message?: string })?.message ?? '加载失败';
      wx.showToast({ title: msg, icon: 'none' });
    }
  },

  onSubscribe() {
    const code = this.data.user?.invite_code;
    const paid = this.data.user?.is_paid;
    if (!code) {
      wx.showToast({ title: '请重新登录后再试', icon: 'none' });
      return;
    }
    wx.showModal({
      title: paid ? '续费' : '即将上线',
      content: paid
        ? `微信联系 UnheardBili 续费\n你的开通码：${code}\n转账后 24h 内手动续期。`
        : `微信支付正在接入，期间联系运营手动开通：\n\n1. 微信联系 UnheardBili\n2. 告知开通码：${code}\n3. 转账 ¥20 → 24h 内开通`,
      confirmText: '复制开通码',
      cancelText: '关闭',
      confirmColor: '#1f1f1c',
      success: (r) => {
        if (r.confirm) this.copyCode();
      },
    });
  },

  onCopyCode() {
    this.copyCode();
  },

  copyCode() {
    const code = this.data.user?.invite_code;
    if (!code) return;
    wx.setClipboardData({
      data: code,
      success: () =>
        wx.showToast({ title: `开通码 ${code} 已复制`, icon: 'none' }),
    });
  },
});
