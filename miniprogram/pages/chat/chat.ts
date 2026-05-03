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
    remaining: 0,
    limit: 10,
    bonus: 0,
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
      remaining: user.remainingUses,
      limit: user.today_limit ?? 10,
      bonus: user.bonus_balance ?? 0,
    });
  },

  async onShow() {
    if (!app.globalData.user) return;
    try {
      // 拉取最新 /auth/me，刷新 remaining / bonus / today_limit（含付费态变更）
      const fresh = await api.me();
      app.setUser(fresh);
      this.setData({
        user: fresh,
        quotaExhausted: fresh.remainingUses <= 0,
        remaining: fresh.remainingUses,
        limit: fresh.today_limit ?? 10,
        bonus: fresh.bonus_balance ?? 0,
      });
    } catch {
      // 静默失败：保留老值
    }
  },

  onInput(e: { detail: { value: string } }) {
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
    // 节流 setData：真流式下 delta 频繁，每 80ms 才 flush 一次，避免渲染卡死
    let lastFlushAt = 0;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flushNow = () => {
      lastFlushAt = Date.now();
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      this.updateAiMessage(aiId, accumulated, true);
    };
    const scheduleFlush = () => {
      const since = Date.now() - lastFlushAt;
      if (since >= 80) {
        flushNow();
      } else if (!flushTimer) {
        flushTimer = setTimeout(flushNow, 80 - since);
      }
    };
    api.chatStream(llmMessages, {
      onDelta: (delta) => {
        if (accumulated.length === 0) console.log('[lt] first delta arrived, len=', delta.length);
        accumulated += delta;
        scheduleFlush();
      },
      onWarning: (msg) => {
        wx.showToast({ title: msg, icon: 'none' });
      },
      onDone: async (remainingUses) => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        // 防御：流式断了或 fallback 解析失败时不要信 remainingUses=0
        if (accumulated.length === 0) {
          const rollback = this.data.messages.filter((m) => m.id !== aiId);
          this.setData({ messages: rollback, sending: false });
          wx.showToast({ title: '没收到回复，再试一次', icon: 'none' });
          return;
        }
        const finalText = accumulated || '...';
        this.updateAiMessage(aiId, finalText, false);
        appendHistory(user.openid, { role: 'assistant', content: finalText });
        // remainingUses < 0 是「未知」哨兵值（兜底场景），不要覆盖原配额
        if (remainingUses < 0) {
          this.setData({ sending: false });
          return;
        }
        const updatedUser = { ...user, remainingUses };
        app.setUser(updatedUser);
        this.setData({
          sending: false,
          user: updatedUser,
          quotaExhausted: remainingUses <= 0,
          remaining: remainingUses,
        });
        // chatStream 的 done 只回传当日 remaining，bonus 可能也被消耗了，
        // 重新拉一次 /auth/me 同步 bonus_balance / today_limit / 付费态。
        try {
          const fresh = await api.me();
          app.setUser(fresh);
          this.setData({
            user: fresh,
            bonus: fresh.bonus_balance ?? 0,
            limit: fresh.today_limit ?? 10,
          });
        } catch {
          /* ignore refresh failure */
        }
      },
      onError: (code, message) => {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
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

  onShareAppMessage() {
    const ic = app.globalData.user?.invite_code;
    return {
      title: '童锦程教你怎么搞定她',
      path: ic ? `/pages/login/login?ic=${ic}` : '/pages/login/login',
      // TODO: produce assets/share-cover.png (5:4 ratio) before体验版上传
      imageUrl: '/assets/share-cover.png',
    };
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
