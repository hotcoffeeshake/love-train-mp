import { CLOUDBASE_ENV_ID } from './utils/consts';
import type { UserInfo } from './utils/api';

App<IAppOption>({
  globalData: {
    user: null,
    cloudInited: false,
  },
  onLaunch() {
    if (!wx.cloud) {
      console.error('wx.cloud is undefined — 小程序基础库过低或未开通云开发');
      return;
    }
    try {
      wx.cloud.init({
        env: CLOUDBASE_ENV_ID || undefined,
        traceUser: true,
      });
      this.globalData.cloudInited = true;
    } catch (err) {
      console.error('wx.cloud.init failed', err);
    }
  },
  setUser(u: UserInfo | null) {
    this.globalData.user = u;
  },
});

declare global {
  interface IAppOption {
    setUser(u: UserInfo | null): void;
  }
}

export {};
