import { api, BackendError, type ChatMessage, type UserInfo } from '../../utils/api';
import {
  appendHistory,
  clearDraft,
  clearHistory,
  loadDraft,
  loadHistory,
  saveDraft,
} from '../../utils/storage';

const app = getApp<IAppOption>();

interface RenderMsg extends ChatMessage {
  id: string;
  pending?: boolean;
}

Page({
  data: {
    user: null as UserInfo | null,
    messages: [] as RenderMsg[],
    draft: '',
    sending: false,
    quotaExhausted: false,
    scrollToId: '',
  },

  onLoad() {
    if (!app.globalData.user) {
      wx.reLaunch({ url: '/pages/login/login' });
      return;
    }
    const user = app.globalData.user;
    const history = loadHistory(user.openid).map((m, i) => ({
      ...m,
      id: `h-${i}`,
    }));
    this.setData({
      user,
      messages: history,
      draft: loadDraft(),
      quotaExhausted: user.remainingUses <= 0,
      scrollToId: history.length ? `h-${history.length - 1}` : '',
    });
  },

  async onShow() {
    if (!app.globalData.user) return;
    try {
      const q = await api.quota();
      const user = { ...app.globalData.user, remainingUses: q.remainingUses };
      app.setUser(user);
      this.setData({ user, quotaExhausted: q.remainingUses <= 0 });
    } catch {
      // 静默失败：保留老值
    }
  },

  onInput(e: WechatMiniprogram.Input) {
    const v = e.detail.value;
    this.setData({ draft: v });
    saveDraft(v);
  },

  async onSend() {
    const { draft, sending, quotaExhausted, user, messages } = this.data;
    if (sending || !user) return;
    const text = draft.trim();
    if (!text) return;
    if (quotaExhausted) {
      wx.showToast({ title: '今日 10 次已用完', icon: 'none' });
      return;
    }

    const userMsg: RenderMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
    };
    const pendingAi: RenderMsg = {
      id: `a-${Date.now()}`,
      role: 'assistant',
      content: '思考中...',
      pending: true,
    };

    const next = [...messages, userMsg, pendingAi];
    this.setData({
      messages: next,
      draft: '',
      sending: true,
      scrollToId: pendingAi.id,
    });
    clearDraft();
    appendHistory(user.openid, { role: userMsg.role, content: userMsg.content });

    try {
      const res = await api.chat(
        next
          .filter((m) => !m.pending)
          .map((m) => ({ role: m.role, content: m.content })),
      );
      const finalAi: RenderMsg = {
        id: pendingAi.id,
        role: 'assistant',
        content: res.content,
      };
      const finalMsgs = next.map((m) => (m.id === pendingAi.id ? finalAi : m));
      appendHistory(user.openid, { role: 'assistant', content: res.content });
      const updatedUser = { ...user, remainingUses: res.remainingUses };
      app.setUser(updatedUser);
      this.setData({
        messages: finalMsgs,
        sending: false,
        user: updatedUser,
        quotaExhausted: res.remainingUses <= 0,
        scrollToId: finalAi.id,
      });
    } catch (err) {
      const rollback = messages.concat(userMsg);
      let errText = '网络开小差，再试一次';
      if (err instanceof BackendError) {
        if (err.code === 'RATE_LIMIT') errText = '今日 10 次已用完，明天再来';
        else if (err.code === 'INVALID_BODY') errText = '消息格式不对';
        else errText = err.message || errText;
      }
      this.setData({
        messages: rollback,
        sending: false,
        quotaExhausted: err instanceof BackendError && err.code === 'RATE_LIMIT',
      });
      wx.showToast({ title: errText, icon: 'none' });
    }
  },

  onAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },

  async onClearHistory() {
    const { user } = this.data;
    if (!user) return;
    const ok = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '清空聊天',
        content: '聊天记录会被清空（不影响配额）',
        success: (r) => resolve(r.confirm),
      });
    });
    if (!ok) return;
    clearHistory(user.openid);
    this.setData({ messages: [] });
  },
});
