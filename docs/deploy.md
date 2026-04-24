# 部署到微信云托管

## 前置

- 已注册小程序，拿到 AppID
- 小程序管理后台 -> 开发 -> 云开发 -> 已开通
- 云开发控制台 -> 云托管 -> 创建服务 `love-train-mp`

## 步骤

### 1. 配置环境变量

云托管控制台 -> 服务 -> 设置 -> 环境变量：

**默认方案（推荐）：CloudBase 内置 AI，零密钥**

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `LLM_PROVIDER` | `cloudbase-hunyuan` |
| `CLOUDBASE_ENV_ID` | <你的云开发环境 ID> |
| `DAILY_QUOTA` | `10` |
| `WX_APPID` | <你的 AppID> |
| `MONGODB_URI` | <云开发 MongoDB 连接串，控制台自动提供> |
| `MONGODB_DB` | `love-train-mp` |

云托管内**不需要 TENCENT_SECRET_ID / SECRET_KEY**，微信服务自动鉴权。

**可选 provider 值**：
- `cloudbase-hunyuan`（默认，走混元 `hunyuan-2.0-instruct-20251111`）
- `cloudbase-deepseek`（走 `deepseek-v3.2`）
- `deepseek`（外网 DeepSeek，需 `LLM_API_KEY`，跨境延迟高）
- `claude` / `hunyuan`（M4 再实现）

**本地开发**（非云托管环境）：额外配 `TENCENT_SECRET_ID` + `TENCENT_SECRET_KEY`。

### 2. 部署代码

两种方式：

**A. GitHub 绑定（推荐）**
- 云托管服务 -> 版本管理 -> 代码源：GitHub
- 绑定仓库 `love-train-mp`，分支 `main`，目录 `container/`
- 每次 `git push main` 自动构建 + 灰度

**B. 手动上传**
- 云托管服务 -> 版本管理 -> 新建版本 -> 上传代码
- 根目录选 `container/`

### 3. 服务配置

- CPU: 0.5 核 / 内存: 1GB（MVP）
- 副本数：最小 1，最大 3
- 端口：3000
- 启动命令：默认（使用 Dockerfile CMD）
- 健康检查路径：`/health`

### 4. 验证

云托管服务详情页 -> 复制"内网调用地址"，在微信开发者工具控制台：

```js
wx.cloud.callContainer({
  path: '/health',
  method: 'GET',
  config: { env: '<your-env-id>' },
  header: { 'X-WX-SERVICE': 'love-train-mp' },
}).then(console.log);
```

Expected: `{ ok: true, timestamp: ... }`

## 排障

- `MISSING_OPENID` 401 -> 检查是否通过 `wx.cloud.callContainer` 调用（而非公网 URL）
- LLM 超时 -> 加 `LLM_API_URL` 走腾讯云 DeepSeek 内网端点
- MongoDB 连接失败 -> 云托管 -> 服务 -> 设置 -> 启用"微信服务"开关
