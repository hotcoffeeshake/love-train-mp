# love-train 小程序 · Handoff 文档

> 截至 **2026-04-28**，状态 = 体验版可跑通文字 + 图片对话，UI 已按 Claude Design 落地。
> 给接手人用，**先读这一份再读代码**。

---

## 1. 它是什么

- **产品**：童锦程风格、男性向情感咨询 AI（诊断 + 行动方案）。微信小程序版本，独立于网页版（lovetrain.space）。
- **形态**：小程序前端 + WeChat CloudBase 云托管后端 + DeepSeek（用户自有 API key 经 CloudBase 转发）。
- **核心闭环**：登录 → 输入文字/图片 → OCR + 内容审核 + LLM 流式生成 → 渲染回复 → 配额扣减。

## 2. 当前进度

| 里程碑 | 状态 |
|---|---|
| M0 配置/脚手架 | ✅ |
| M1 后端 API + DB + 配额 | ✅ |
| M2 流式聊天（NDJSON）+ 安全降级 | ✅ |
| M3 OCR 多图 + 内容审核兜底 | ✅ |
| M3.5 Claude Design UI 改造 | ✅（本次完成） |
| M4 体验版上传 + 测试者收集反馈 | ⏳ 准备中 |
| M5 提审上线（需要企业主体 + 内容审核打通） | 🔜 |

---

## 3. 关键账号 / 资源（不要搞错！）

> ⚠️ **有两个微信/腾讯云账号容易混淆**

| 维度 | 值 |
|---|---|
| 小程序 AppID | `wxd33f35dec128e040` |
| CloudBase 环境 ID | `cool123-d0gec5og96116475f`（**不是** `hotcoffeeshake-...`，那是网页版的） |
| 云托管服务名 | `love-train-mp3`（注意结尾的 `3`） |
| 默认域名 | `love-train-mp3-cool123-d0gec5og96116475f-1425698520.sh.run.tcloudbase.com` |
| LLM provider 配置 | 环境变量 `LLM_PROVIDER=cloudbase-deepseek-custom`，模型厂商在控制台叫 `deepseek-open-custom`，端点 `https://api.deepseek.com/v1`，**API key 由用户在 CloudBase 控制台填入**（不在代码里） |
| OCR | 腾讯云 OCR `GeneralBasicOCR`，密钥走环境变量 `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` |
| 数据库 | CloudBase 文档型 NoSQL，集合 `users`、`daily_usage` |

> 🚨 **TENCENT_SECRET_ID/KEY 在更早的会话里被打到聊天界面过——上线前必须 rotate。**

---

## 4. 代码结构

```
love-train-mp/
├── cloudbaserc.json              # tcb CLI 部署用，写死 env + service 名
├── container/                    # 后端（部署到云托管）
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── server.ts             # Fastify 入口
│       ├── config.ts             # 读环境变量
│       ├── middleware/openid.ts  # 解 X-WX-OPENID 注入 req.openid
│       ├── routes/
│       │   ├── auth.ts           # /auth/me
│       │   ├── chat.ts           # /chat（核心：流式 + OCR + 审核）
│       │   ├── user.ts           # /user/quota /user/profile
│       │   ├── debug.ts          # /debug/env /debug/ocr-raw（仅调试用）
│       │   └── health.ts
│       ├── llm/
│       │   ├── index.ts          # createProvider 路由
│       │   ├── cloudbase.ts      # 走 CloudBase AI（带 createModel）
│       │   ├── deepseek.ts       # 直连 DeepSeek（非 CloudBase 时用）
│       │   └── strip-markdown.ts # 服务端 markdown 剔除（最终防线）
│       ├── ocr/tencent-ocr.ts
│       ├── security/wechat-security.ts  # msgSecCheck / imgSecCheck
│       ├── storage/cos.ts
│       ├── system-prompt.ts      # 从 lib/system-prompt.ts 同步
│       └── db/
│           ├── adapter.ts
│           ├── cloudbase-adapter.ts  # 生产
│           └── mongo-adapter.ts      # 测试
└── miniprogram/                  # 前端
    ├── app.ts / app.json / app.wxss   # 全局 Claude Design tokens
    ├── pages/
    │   ├── login/                # serif italic l + 黑底登录
    │   ├── chat/                 # 核心；textarea 自适应 + 橙↑发送
    │   └── about/                # 米白卡片 + 酒红清空按钮
    ├── components/
    │   ├── quota-badge/          # 「今日 4 — 10」横线样式
    │   └── message-bubble/       # 黑底用户 / 米白 AI + 诊断中橙点
    └── utils/
        ├── api.ts                # callContainer + chatStream + 双触发防御
        ├── consts.ts             # CLOUDBASE_ENV_ID / 服务名 / 配额
        ├── storage.ts            # 本地聊天 / 草稿
        └── upload.ts             # 图片压缩 + COS 上传
```

---

## 5. 核心数据流

### 文字 + 图片 → 回复（端到端）

```
[小程序]
  wx.cloud.uploadFile (图片到 COS, 拿到 fileID)
  wx.cloud.callContainer POST /chat
    body: { messages: [{ role, content, fileIDs }], stream: true }

[后端 /chat]
  1. checkText(用户最新消息)         ← msgSecCheck v2，失败降级放行
  2. for each fileID in images.slice(0, 5):
       downloadFileAsBase64        ← 走 cloud.downloadFile
       checkImage                   ← imgSecCheck，失败降级放行
       ocrImageBase64               ← 腾讯云 GeneralBasicOCR
     拼成 [图片N OCR 文字]\n... 注入 user content
  3. llm.chatStream(messages, onDelta)
     - DeepSeek 通过 CloudBase 自建 provider 路由
     - 流式输出，按行（\n）切批次写 ndjson delta
     - 后端有 8s 心跳 ping 防网关超时
  4. 全部完成后：incrementUsage（DB 计数 +1）→ 写 ndjson done

[小程序]
  success 回调收齐 NDJSON string（callContainer 不真支持 chunked）
  fallback 解析每行 ndjson → onDelta(merged) + onDone(remaining)
  ⚠️ 关键防御：chunkPathActive 标志位防 onDone 双触发归零
```

---

## 6. 已知坑（**接手必读**）

### 6.1 微信 callContainer 不真正支持流式
- `enableChunked: true` + `onChunkReceived` **在当前基础库（3.15.x）下实测不生效**——success 收到空 string，chunks 全丢
- 当前妥协：**关掉 enableChunked**，让微信汇总为一个 string 一次性给 success，fallback 解析
- 代价：**没有真正的"字一个个流出来"效果**，AI 回复一次性出整段
- 后续优化：等基础库支持 / 改用 SSE 中转层 / 自建 wss

### 6.2 onDone 双触发归零 bug（已修但要小心）
- 历史 bug：success 回调与 chunk 路径同时调用 onDone，第二次以 0 覆盖配额
- 防御：`chunkPathActive + doneFired` 两个标志位 + accumulatedLen=0 时按 error 处理
- 不要随便简化 `api.ts` 里的 success 分支判断

### 6.3 内容安全审核当前是"降级放行"
- `imgSecCheck` / `msgSecCheck` 报 `INVALID_WX_ACCESS_TOKEN`，原因：CloudBase 环境与 AppID 的"云调用"权限链路没完全打通
- 现状：**所有内容审核被静默跳过**——发什么内容都过
- 提审上线前必须修：要么打通云调用授权，要么自己实现一套审核
- 代码侧：`security/wechat-security.ts` 已经做了一次性提示日志

### 6.4 CloudBase 内置 AI token 配额会爆
- 早期用 `cloudbase-deepseek` 会消耗 CloudBase 个人版的 token quota，每月免费额度有限
- **当前已切到 `cloudbase-deepseek-custom`**（用户自己 DeepSeek key），DeepSeek 直接计费
- 不要切回 `cloudbase-deepseek`，除非升级套餐

### 6.5 102002 网关超时
- 微信 callContainer 单请求若静默超过 ~30s 会断，前端报 `cloud.callContainer:fail 102002`
- 后端写 ndjson 时一直有数据流出，且写完即 end，理论上不会超时
- 真正风险：LLM 响应特别慢（>60s）。当前 DeepSeek 一般 5-15s，没问题
- 监控建议：`firstMs > 15000` 的请求要警觉

### 6.6 体验版 vs 真机调试 vs 模拟器
- **体验版**用的是上次"上传"时的代码快照，编译只更新模拟器
- 真机调试也是当时的代码，断开重连才会刷新
- 改了前端代码必须重新"上传体验版"才能让测试者看到
- 测试只在模拟器里测，跟体验版可能脱节

### 6.7 实例数量 / 冷启动
- 当前 `MinNum=1`，避免冷启动，但月费稍贵
- 多并发用户来时第 N 个会冷启动 10–30s
- 现阶段（10 人内测）够用；上线后扩 MinNum=2 或 MaxNum 拉高

---

## 7. 部署 / 运维

### 部署后端
```bash
# 1. 登录（用 cool123 那个账号）
tcb login

# 2. 编译 + 部署（必须从仓库根目录上传，service 配置里 BuildDir=container）
cd /Users/qichenxie/Desktop/love-train-mp/container && npm run build
cd /Users/qichenxie/Desktop/love-train-mp
yes "" | tcb cloudrun deploy -s love-train-mp3 --source . --port 3000 --force

# 部署链接会贴出来，云端构建 ~3min
```

部署不会改环境变量。要改 `LLM_PROVIDER` 等，必须去控制台：
**云托管 → love-train-mp3 → 服务配置 → 环境变量 → 编辑**

### 查日志
**控制台**（推荐）：
- https://tcb.cloud.tencent.com/dev → 选 cool123 环境 → 云托管 → love-train-mp3 → 日志 标签

**CLI**（环境必须开 CLS 日志服务）：
```bash
tcb logs search -e cool123-d0gec5og96116475f --service tcbr \
  --timeRange 10m --limit 60 \
  --query '__TAG__.container_name:/love-train-mp3.*/'
```

### 重置某用户配额
```bash
tcb db nosql execute -e cool123-d0gec5og96116475f --command \
  '[{"TableName":"daily_usage","CommandType":"DELETE","Command":"{\"delete\":\"daily_usage\",\"deletes\":[{\"q\":{\"openid\":\"<openid>\",\"date\":\"<YYYY-MM-DD>\"},\"limit\":0}]}"}]'
```

### 部署前端
- 微信开发者工具 → 打开 `~/Desktop/love-train-mp/miniprogram` → 编译 → 上传
- 然后 微信公众平台 → 版本管理 → 选为体验版

---

## 8. 待办（按优先级）

### P0 提审前必须
- [ ] **轮换 TENCENT_SECRET_ID/KEY**（之前在聊天里暴露过）
- [ ] 修 INVALID_WX_ACCESS_TOKEN，让内容审核真生效（云调用授权 / 改方案）
- [ ] 上传新体验版用最新前端代码（含本次 UI 改造）
- [ ] 删 `[lt]` 调试日志（在 `api.ts` / `chat.ts` 搜 `[lt]`）

### P1 收集反馈
- [ ] 测试者群里收 5-10 个反馈，记录到 `docs/feedback.md`
- [ ] AI 回复质量调优（system-prompt 在 `container/src/system-prompt.ts`，从 `love-train/lib/system-prompt.ts` 同步）

### P2 上线
- [ ] 个人主体 → 企业主体（推荐 Path B：新 AppID）
- [ ] 微信支付（如果做付费版）
- [ ] M4 / M5 文档里的合规清单

### 待优化
- [ ] 真流式输出：等基础库支持 / 自建 SSE
- [ ] 离线 / 网络差时的体验降级
- [ ] AI 回复带 markdown 时的渲染（目前 strip 掉，丑）
- [ ] 设计稿里的"诊断中"标签流式时显示，已实现但只在 `loading=true` 时；想做"诊断完成"小气泡需要新状态

---

## 9. 测试 / 验证 checklist

进入小程序时验：

- [ ] 登录页米白底 + 橙色大写 `l` + 黑底登录按钮
- [ ] 聊天页橙头像 + 配额「今日 N — 10」横线样式
- [ ] 空态文字「兄弟，把你那情况发我看看。」
- [ ] 发图：thumbnails 出现在输入区上方，可单个删除
- [ ] 发送：橙↑按钮，激活/禁用色切换正确
- [ ] AI 回复：米白卡片，诊断中阶段左上角橙圆点 + 「诊断中」+ 闪烁光标
- [ ] 回复完成后：配额数字 -1，不会瞬间归零
- [ ] 关于页：黑色圆角 logo + serif 品牌 + 三张卡（每张前橙色小圆点）+ 酒红 ghost「清空」按钮

---

## 10. 文档索引

- `docs/handoff.md` — 本文件
- `docs/claude-design-brief.md` — UI 改造 brief（已落地）
- `docs/deploy.md` — 部署说明（CLI + 控制台）
- `docs/sync-system-prompt.md` — system-prompt 同步说明（从 love-train 仓库）

---

接手第一步：**走一遍 §3、§6、§9**，跑通模拟器登录-聊天-发图，再决定下一步。
