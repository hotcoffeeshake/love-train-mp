Page({
  data: {
    version: '0.1.0',
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
        // 清掉所有 chat:history:<openid> 和 chat:draft
        try {
          const info = wx.getStorageInfoSync();
          (info.keys || []).forEach((k) => {
            if (k.startsWith('chat:history:') || k === 'chat:draft') {
              wx.removeStorageSync(k);
            }
          });
        } catch {}
        wx.showToast({ title: '已清空', icon: 'success' });
      },
    });
  },
});
