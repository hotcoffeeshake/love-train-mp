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
    if (!code) {
      wx.showToast({ title: '请重新登录后再试', icon: 'none' });
      return;
    }
    // 一键复制运营微信号，引导去 WeChat 加好友
    wx.setClipboardData({
      data: 'UnheardBili',
      success: () => {
        wx.showModal({
          title: '微信号已复制',
          content: `微信号 UnheardBili 已复制到剪贴板。\n打开微信搜索 → 加好友 → 发送你的开通码：${code}\n转账 ¥20 → 24h 内开通。`,
          confirmText: '复制开通码',
          cancelText: '知道了',
          confirmColor: '#1f1f1c',
          success: (r) => {
            if (r.confirm) this.copyCode();
          },
        });
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
