import type { UserInfo } from '../utils/api';

declare global {
  interface IAppOption {
    globalData: {
      user: UserInfo | null;
      cloudInited: boolean;
    };
  }
}

export {};
