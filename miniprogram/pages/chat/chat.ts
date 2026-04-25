import { api, BackendError, type ChatMessage, type UserInfo } from '../../utils/api';
import {
  appendHistory,
  clearDraft,
  clearHistory,
  loadDraft,
  loadHistory,
  saveDraft,
} from '../../utils/storage';
import { pickAndUpload } from '../../utils/upload';

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
    pendingFileIDs: [] as string[],
    uploadingImages: false,
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

  async onPickImages() {
    const { user, pendingFileIDs, uploadingImages } = this.data;
    if (!user || uploadingImages) return;
    this.setData({ uploadingImages: true });
    try {
      const fileIDs = await pickAndUpload(pendingFileIDs.length, user.openid);
      if (fileIDs.length) {
        this.setData({
          pendingFileIDs: [...pendingFileIDs, ...fileIDs],
        });
      }
    } catch (err) {
      const msg = (err as { errMsg?: string })?.errMsg ?? '';
      if (!msg.includes('cancel')) {
        wx.showToast({ title: '图片上传失败', icon: 'none' });
      }
    } finally {
      this.setData({ uploadingImages: false });
    }
  },

  onRemoveImage(e: WechatMiniprogram.TouchEvent) {
    const idx = Number(e.currentTarget.dataset.idx);
    const next = [...this.data.pendingFileIDs];
    next.splice(idx, 1);
    this.setData({ pendingFileIDs: next });
  },

  onSend() {
    const { draft, sending, quotaExhausted, user, messages, pendingFileIDs } = this.data;
    if (sending || !user) return;
    const text = draft.trim();
    if (!text && pendingFileIDs.length === 0) return;
    if (quotaExhausted) {
      wx.showToast({ title: '今日 10 次已用完', icon: 'none' });
      return;
    }

    const userMsg: RenderMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: text,
      fileIDs: pendingFileIDs.length ? [...pendingFileIDs] : undefined,
    };
    const aiId = `a-${Date.now()}`;
    const pendingAi: RenderMsg = {
      id: aiId,
      role: 'assistant',
      content: '',
      pending: true,
    };

    const next = [...messages, userMsg, pendingAi];
    this.setData({
      messages: next,
      draft: '',
      pendingFileIDs: [],
      sending: true,
      scrollToId: aiId,
    });
    clearDraft();
    appendHistory(user.openid, {
      role: userMsg.role,
      content: userMsg.content,
      fileIDs: userMsg.fileIDs,
    });

    const llmMessages: ChatMessage[] = next
      .filter((m) => !m.pending)
      .map((m) => ({
        role: m.role,
        content: m.content,
        fileIDs: m.fileIDs,
      }));

    let accumulated = '';
    api.chatStream(llmMessages, {
      onDelta: (delta) => {
        accumulated += delta;
        this.updateAiMessage(aiId, accumulated, true);
      },
      onWarning: (msg) => {
        wx.showToast({ title: msg, icon: 'none' });
      },
      onDone: (remainingUses) => {
        const finalText = accumulated || '...';
        this.updateAiMessage(aiId, finalText, false);
        appendHistory(user.openid, { role: 'assistant', content: finalText });
        const updatedUser = { ...user, remainingUses };
        app.setUser(updatedUser);
        this.setData({
          sending: false,
          user: updatedUser,
          quotaExhausted: remainingUses <= 0,
        });
      },
      onError: (code, message) => {
        let errText = '网络开小差，再试一次';
        if (code === 'RATE_LIMIT') errText = '今日 10 次已用完，明天再来';
        else if (code === 'UNSAFE_CONTENT') errText = '消息含敏感内容，换个说法';
        else if (code === 'UNSAFE_IMAGE') errText = '图片不合规，请换一张';
        else if (message) errText = message;
        const rollback = this.data.messages.filter((m) => m.id !== aiId);
        this.setData({
          messages: rollback,
          sending: false,
          quotaExhausted: code === 'RATE_LIMIT',
        });
        wx.showToast({ title: errText, icon: 'none' });
      },
    });
  },

  updateAiMessage(id: string, content: string, pending: boolean) {
    const messages = this.data.messages.map((m) =>
      m.id === id ? { ...m, content, pending } : m,
    );
    this.setData({ messages, scrollToId: id });
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
