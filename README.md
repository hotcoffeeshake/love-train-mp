# love-train-mp

微信小程序版 love-train（童锦程风格情感导师 AI）。

## 目录

- `container/` — 云托管后端（Node.js + Fastify）。详见 [container/README](container/) 及 [docs/deploy.md](docs/deploy.md)
- `miniprogram/` — 小程序前端（原生 TS）

## 开发

### 后端

```bash
cd container
npm install
npm test
npm run dev
```

### 前端

1. 用**微信开发者工具**（Stable）打开 `miniprogram/` 目录
2. 首次打开需在工具里填 AppID（或替换 `miniprogram/project.config.json` 中 `wxd33f35dec128e040`）
3. 编辑 `miniprogram/utils/consts.ts` 里的 `CLOUDBASE_ENV_ID` 为你的环境 ID（或留空，由工具云开发下拉选）
4. 开发者工具底部"云开发" → 选择环境 → 云托管服务 `love-train-mp` 必须已部署

### 单元测试

```bash
cd miniprogram
npm install
npm run typecheck
npm test
```

## 发布

### 后端

`git push` → 云托管自动构建。详见 [docs/deploy.md](docs/deploy.md)

### 前端

微信开发者工具 → 上传 → 小程序后台提审 → 审核通过 → 发布

## system-prompt 同步

见 [docs/sync-system-prompt.md](docs/sync-system-prompt.md)
