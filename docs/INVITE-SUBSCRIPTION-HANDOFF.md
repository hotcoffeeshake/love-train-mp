# Invite + Subscription · Implementation Handoff

> 状态：feat/invite-subscription 分支实现完成 · 日期 2026-05-03  
> 关联：[`docs/specs/2026-05-03-invite-and-subscription-design.md`](specs/2026-05-03-invite-and-subscription-design.md) · [`docs/plans/2026-05-03-invite-and-subscription.md`](plans/2026-05-03-invite-and-subscription.md)

---

## 1. 已完成的事

`feat/invite-subscription` 分支共 12 个 commit，全部 TDD 驱动：

| # | Commit | 内容 |
|---|---|---|
| 1 | `0a2ad5e` | 邀请码生成 + 校验工具 |
| 2 | `5c85cfb` | 修注释 typo |
| 3 | `75a4fce` | users 表加 invite_code/inviter_openid/bonus_balance/paid_until + helpers |
| 4 | `b1e9490` | subscriptions 表 + adapter find() |
| 5 | `4c85cd1` | `/invite/bind` 路由 + `/auth/me` 扩展 |
| 6 | `a49d81a` | chat 扣减改先扣 bonus + 动态付费/免费额度 |
| 7 | `7aea325` | `/payment/create-order` mock 模式 + recordPayment service |
| 8 | `59ce855` | `/wxpay/notify` 路由 + 真支付 SDK 接入 |
| 9 | `c29941a` | admin 中间件 + admin API 路由 |
| 10 | `e1e7812` | admin.html 静态后台页 |
| 11 | `f3afa43` | 前端 chat 分享 + login 自动绑定 |
| 12 | `5340aaa` | 前端 about 会员卡 + quota-badge 奖励显示 |

**验证状态**：
- `cd container && npm test` → **76/76 PASS**（16 个测试文件）
- `cd container && npm run typecheck` → **0 errors**
- `cd miniprogram && npx tsc --noEmit -p tsconfig.json` → **0 errors**
- `grep -rn '\[lt\]' container/src miniprogram/` → 无残留调试日志

---

## 2. 你现在能测什么（mock 模式，不收钱）

`WXPAY_MODE=mock` 默认开启，今天就能完整跑通：

### Happy path（按顺序）

1. **A 注册** → 拿到邀请码（`/auth/me` 返回的 `invite_code`，比如 `A8K2P9`）
2. **A 邀请 B**：A 在 chat 页右上角「···」转发 → B 点开
   - 分享 path 自动带 `?ic=A8K2P9`
3. **B 注册** → 系统自动绑定 → A 和 B 各 `+5` bonus
   - 可调： `INVITE_REWARD_INVITER` / `INVITE_REWARD_INVITEE`（默认 5）
4. **B 在 chat 发 1 条消息** → bonus_balance 从 5 变 4，`daily_usage.used` 仍为 0
5. **B 进 about 页** → 看到「免费会员 · 每日 10 次」+ 「开通付费版 ¥20/月」按钮
6. **B 点开通** → modal「已模拟开通付费（测试模式）」→ B 立即变付费用户
7. **B 回 chat** → quota-badge 显示「今日 X / **30**」（付费版额度）
8. **打开 admin 后台** → 看到「待返点」一条：`B paid → A` 的关系

### 失败路径覆盖

- B 已经被 X 邀请，再试 A 的链接 → toast 不弹（静默忽略），后端 `ALREADY_BOUND`
- A 自己点自己分享的链接 → 静默忽略，`SELF_INVITE`
- 老用户（注册 8 天前）拿别人邀请链接 → `WINDOW_EXPIRED`
- 已付费用户拿别人邀请链接 → `WINDOW_EXPIRED`

---

## 3. 部署步骤（你执行）

### 3.1 CloudBase 控制台环境变量

在 https://tcb.cloud.tencent.com/dev → cool123 环境 → 云托管 → love-train-mp3 → 服务配置 → 环境变量：

```
ADMIN_TOKEN=<32 位以上随机串，自己生成>
ADMIN_UI_PATH_SEGMENT=ui-<8 位以上随机串，比如 ui-x9k2abcd>
WXPAY_MODE=mock
INVITE_REWARD_INVITER=5
INVITE_REWARD_INVITEE=5
INVITE_BIND_WINDOW_DAYS=7
DAILY_LIMIT_FREE=10
DAILY_LIMIT_PAID=30
SUBSCRIPTION_AMOUNT_CENTS=2000
SUBSCRIPTION_PERIOD_DAYS=30
```

> ⚠️ `ADMIN_TOKEN` 必填，否则 admin 后台所有 API 返 503。

### 3.2 部署后端

```bash
cd /Users/qichenxie/Desktop/love-train-mp-invite/container && npm run build
cd /Users/qichenxie/Desktop/love-train-mp-invite
yes "" | tcb cloudrun deploy -s love-train-mp3 --source . --port 3000 --force
```

约 3 分钟。

### 3.3 部署前端

1. 微信开发者工具 → 打开 `~/Desktop/love-train-mp-invite/miniprogram/`
2. 编译 → 上传体验版
3. 微信公众平台 → 版本管理 → 选为体验版

> ⚠️ **缺一张分享封面图**：`miniprogram/assets/share-cover.png`（5:4 比例，约 500×400px）。Task 10 留了 TODO 注释。可先用占位图，分享卡仍能正常展示。

### 3.4 admin 后台访问

部署完后，浏览器打开：

```
https://love-train-mp3-cool123-d0gec5og96116475f-1425698520.sh.run.tcloudbase.com/admin/<ADMIN_UI_PATH_SEGMENT>/admin.html
```

把上面填的 `ADMIN_UI_PATH_SEGMENT` 替换进去（比如 `ui-x9k2abcd`）。

进页面 → 顶部输入 `ADMIN_TOKEN` → 点保存 → 看 4 个 tab。

---

## 4. 切换到真支付（未来某天）

主体迁移到个体工商户 + 微信支付商户号下来后：

1. 商户后台拿到：商户号 `mch_id`、商户证书 + 私钥（`apiclient_cert.pem` / `apiclient_key.pem`）、APIv3 密钥（自己设的 32 位字符串）、证书序列号
2. 把 `apiclient_key.pem` 上传到容器（云托管「文件管理」或 Dockerfile COPY 到 `/secrets/`）
3. CloudBase 控制台改 env：
   - `WXPAY_MODE=real`
   - 新增：`WXPAY_APPID`（小程序 AppID `wxd33f35dec128e040`）、`WXPAY_MCHID`、`WXPAY_API_V3_KEY`、`WXPAY_CERT_SERIAL`、`WXPAY_PRIVATE_KEY_PATH=/secrets/apiclient_key.pem`、`WXPAY_NOTIFY_URL=https://<容器域名>/wxpay/notify`
4. 商户后台配 JSAPI 授权目录：`https://<容器域名>/`
5. 小程序后台「服务器域名 → request 合法域名」加 `https://api.mch.weixin.qq.com`
6. 重新部署容器
7. 真机测一笔 1 分钱（暂时改 `SUBSCRIPTION_AMOUNT_CENTS=1`）

代码 0 改动，全靠 env 切换。

---

## 5. 合并回 main 时注意

主仓库 `~/Desktop/love-train-mp/` 的 main 上有**未提交的 UI 改动**（`message-bubble`、`about` 等的 Claude Design 风格调整）。这些不在 `feat/invite-subscription` 上。

合并选项：

**A**（推荐）：先把 main 的 UI 改动 commit 掉，再 merge `feat/invite-subscription`
```bash
cd /Users/qichenxie/Desktop/love-train-mp
git add -A && git commit -m "ui: claude design overhaul (sync from working tree)"
git merge feat/invite-subscription
# 解决 about.wxml 等冲突，UI 风格保留 + 邀请/付费区块新增
```

**B**：把 UI 改动 stash，先 merge feat 分支，再 pop stash 手动整合
```bash
git stash push -u -m "ui-overhaul"
git merge feat/invite-subscription
git stash pop
# 手动合并 about.wxml + about.wxss
```

合并后清理 worktree：
```bash
cd /Users/qichenxie/Desktop/love-train-mp
git worktree remove ../love-train-mp-invite
git branch -d feat/invite-subscription
```

---

## 6. 已知 v1 取舍（acceptable for ≤50 users）

- **bindInviter step-2 race**：concurrent 重复 bind 可能 inviter 多得一份奖励。spec §10 文档说明。
- **decrementBonusAtomic 名为 atomic 但实际是 read-then-write**：v1 规模可接受。
- **wxpay SDK 21 个 transitive 漏洞**（`superagent` deprecated）：SDK 自身问题，等上游升级。
- **`/admin/health` 也被 token 鉴权门控**：spec 没要求公开，无影响。
- **per-message `/auth/me` re-fetch**：每次发完消息多一次 GET 拉 bonus_balance。Plan 已注释为可接受。

---

## 7. 下一步建议

1. **先合并到 main**（按 §5 的 A/B 方案），这是 12 个 commit 的总成果。
2. **配齐 env + 部署**（§3）。
3. **跑一遍 happy path**（§2.1）。
4. **拉 5–10 个测试者**走邀请绑定 → mock 付费 → admin 看待返点列表的完整链路。
5. **主体迁移启动**（§4）：现在就可以开始做工商户营业执照 + 微信支付商户号申请，约 1.5–2 个月。
6. 收集足够 mock 模式反馈后再切真支付。

---

## 8. 索引

- 本文件：`docs/INVITE-SUBSCRIPTION-HANDOFF.md`
- 设计 spec：`docs/specs/2026-05-03-invite-and-subscription-design.md`
- 实施 plan：`docs/plans/2026-05-03-invite-and-subscription.md`
- 历史 handoff：`docs/handoff.md`
