Component({
  properties: {
    role: { type: String, value: 'user' },
    content: { type: String, value: '' },
    loading: { type: Boolean, value: false },
    fileIDs: { type: Array, value: [] as string[] },
  },
  methods: {
    onPreview(e: WechatMiniprogram.TouchEvent) {
      const idx = Number(e.currentTarget.dataset.idx) || 0;
      const urls = this.data.fileIDs as string[];
      if (!urls.length) return;
      wx.previewImage({ current: urls[idx], urls });
    },
  },
});
