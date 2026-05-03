# love-train 小程序 · 邀请关系 + 配额奖励 + 付费返点 设计

> 状态：草案 · 日期 2026-05-03 · 关联 [`docs/handoff.md`](../handoff.md)

---

## 1. 背景与目标

当前小程序已具备：登录、流式聊天、OCR、配额（10/日）、内容审核降级。

本次新增三件强相关的事：

1. **邀请关系**：用户在小程序内分享给好友/群，新用户通过分享链接首次进入并登录后，绑定"邀请人 → 被邀请人"关系。微信不"自带"识别分享者身份，必须由分享者在 `path` query 里自报（用稳定的短码 `invite_code`，不暴露 openid）。
2. **配额奖励**：成功邀请双方各 +N 持久奖励配额（`bonus_balance`），发消息时优先扣它，再扣每日基础额度。
3. **付费与返点（手动）**：付费版（¥20/月，未来接微信支付）享更高每日额度（30/日）+ 免广告。付费时如果有上级，记录返点关系；返点金额由运营手动决定与转账，程序只**记录关系 + 标记已/待返点**，不规定金额。

目标用户：当前 10–50 人体验版规模。所有 admin 操作走 HTTP 接口 + 静态后台页（运营端 = 项目所有者本人）。

---

## 2. 范围与不做的事

### 范围内
- 邀请码生成、分享路径、首次登录绑定
- 持久 `bonus_balance` 配额奖励
- 付费/免费区分 → 不同每日额度 + `is_paid` 标志（前端可据此渲染 / 屏蔽广告）
- 手动 `/admin/mark-paid` 写订阅记录 + 返点状态机
- 静态 admin HTML 页面（容器同源，token 鉴权）

### 不做（YAGNI）
- ❌ 自动微信支付集成（个体工商户主体到位后另开一个 task）
- ❌ 多级分销（仅 1 层 inviter）
- ❌ 邀请海报 / 落地页 / 排行榜
- ❌ 小程序内"我的邀请战绩"视图（不给邀请人看）
- ❌ 退款逻辑（手动改 DB）
- ❌ 小程序内广告系统本身（仅预留 `is_paid` 给将来接广告时门控）

---

## 3. 数据模型

### 3.1 `users` 集合 — 新增字段

```ts
{
  // 既有
  openid: string
  created_at: Date
  // ...

  // 本次新增
  invite_code: string         // 6 位 [A-Z0-9] 唯一码，注册时一次性生成
  inviter_openid: string|null // 我的上级；绑定后永不可改
  invited_at: Date|null       // 绑定时间
  bonus_balance: number       // 奖励配额余额（>=0）
  paid_until: Date|null       // 付费到期时间；> now() 即视为付费用户
}
```

**默认值**：`invite_code` 注册时生成，`inviter_openid/invited_at/paid_until = null`，`bonus_balance = 0`。

**`invite_code` 生成**：
- 字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`（去掉易混的 0/O/1/I/L）共 32 字符
- 长度 6 → 32^6 ≈ 10.7 亿，10 万人内冲突概率 < 0.5%
- 注册时循环生成 + 唯一索引，冲突最多重试 5 次

### 3.2 `subscriptions` 集合 — 新建

每次手动标记付费产生一行（**append-only**，永不删改主体字段）：

```ts
{
  _id: string               // CloudBase 自动
  openid: string            // 付费人

  // ★ 邀请关系 snapshot
  inviter_openid: string|null  // 付费时刻的上级，写入后即冻结

  // 付费信息
  amount: number            // 用户付的钱（元），通常 20
  paid_at: Date             // 我方收到付款的时间
  period_start: Date        // 服务开始时间
  period_end: Date          // 服务结束时间（period_start + SUBSCRIPTION_PERIOD_DAYS）
  payment_ref: string       // 付款参考：微信转账号/wxpay transaction_id/备注等

  // 返点状态机
  rebate_status: 'none' | 'pending' | 'paid'
                            //  none = 没有上级，本来就不返
                            //  pending = 有上级，待手动转账
                            //  paid = 已手动转账
  rebate_paid_at: Date|null // 返点完成时间
  rebate_note: string|null  // 自由文本："¥10 微信转账 备注 xxx"
}
```

**为什么 `inviter_openid` 要 snapshot 进 subscription**：将来若 user 被清理 / inviter_openid 字段误改，账目仍可追。订阅记录是 source of truth。

**索引建议**：`{ openid: 1, paid_at: -1 }` + `{ rebate_status: 1, paid_at: -1 }`。

### 3.3 `daily_usage` 集合 — 不动结构，改使用语义

字段 `{ openid, date, used }` 不变。

**校验改动**：原本硬编码 `used < 10`，改为 `used < currentUserDailyLimit`：
- 付费用户（`users.paid_until > now()`）：`DAILY_LIMIT_PAID`（默认 30）
- 否则：`DAILY_LIMIT_FREE`（默认 10）

---

## 4. 后端 API

### 4.1 用户态接口（鉴权 = 既有 openid 中间件）

#### `GET /user/me`
扩展既有响应，加 4 个字段：

```jsonc
{
  "openid": "oXxx...",
  "created_at": "2026-05-03T...",
  "today_used": 3,
  "today_limit": 10,        // ← 改为基于 paid_until 计算
  "is_paid": false,         // ← 新增
  "paid_until": null,       // ← 新增
  "invite_code": "A8K2P9",  // ← 新增
  "inviter": null,          // ← 新增；已绑定时返回 { invite_code: "B3M7Q1" }
  "bonus_balance": 5        // ← 新增
}
```

#### `POST /invite/bind`
```jsonc
// req
{ "code": "B3M7Q1" }

// res 200
{ "ok": true, "bonus_added": 5 }

// res 400
{ "ok": false, "code": "SELF_INVITE" | "ALREADY_BOUND" | "WINDOW_EXPIRED" | "CODE_NOT_FOUND" | "INVALID_CODE_FORMAT" }
```

**后端处理**：
1. 校验 `code` 格式 → `INVALID_CODE_FORMAT`
2. 查 `users` 找 inviter；找不到 → `CODE_NOT_FOUND`
3. inviter 是自己 → `SELF_INVITE`
4. 当前 user 已有 `inviter_openid` → `ALREADY_BOUND`
5. 当前 user `paid_until != null` 或 `created_at` 距今 > `INVITE_BIND_WINDOW_DAYS` 天 → `WINDOW_EXPIRED`
6. **事务（或两步幂等更新）**：
   - 当前 user：`inviter_openid = inviter.openid`，`invited_at = now`，`bonus_balance += INVITE_REWARD_INVITEE`
   - inviter：`bonus_balance += INVITE_REWARD_INVITER`
7. 返回 `{ ok: true, bonus_added: INVITE_REWARD_INVITEE }`

> CloudBase NoSQL 不支持多文档事务；用"先更新当前 user（带 `inviter_openid==null` 条件）→ 成功后再 +inviter bonus"两步：第二步失败概率极低，失败时记日志、写补偿队列（v1 暂仅记日志，后续运维侧可手动修正）。

### 4.2 Admin 接口（鉴权 = `X-Admin-Token` header）

```
POST /admin/mark-paid
GET  /admin/rebates?status=pending|paid
POST /admin/rebates/:subscription_id/mark-paid
GET  /admin/subscriptions?limit=50&offset=0
```

#### `POST /admin/mark-paid`
```jsonc
// req
{
  "openid": "oXxx...",
  "amount": 20,
  "payment_ref": "WXP-2026-05-03-001",
  "months": 1                    // 默认 1
}

// res 200
{
  "ok": true,
  "subscription_id": "...",
  "rebate_status": "pending",    // 或 "none"
  "paid_until": "2026-06-03T..."
}
```

后端处理：
1. 查 user，不存在 → 404
2. 计算 `period_start = max(now, user.paid_until || now)`，`period_end = period_start + months * SUBSCRIPTION_PERIOD_DAYS`
3. 写 subscription 行（`inviter_openid = user.inviter_openid` snapshot；`rebate_status = 'pending' if inviter else 'none'`）
4. 更新 `user.paid_until = period_end`

#### `GET /admin/rebates?status=pending`
```jsonc
[
  {
    "subscription_id": "...",
    "paid_user": {
      "openid": "oXxx...",
      "invite_code": "A8K2P9",
      "paid_at": "2026-05-03T...",
      "amount": 20
    },
    "inviter": {
      "openid": "oYyy...",
      "invite_code": "B3M7Q1"
    },
    "rebate_status": "pending"
  }
]
```

`?status=paid` 时额外含 `rebate_paid_at` 和 `rebate_note`。

#### `POST /admin/rebates/:subscription_id/mark-paid`
```jsonc
// req
{ "rebate_note": "¥10 微信转账 备注 xxx" }

// res 200
{ "ok": true }
```

校验：subscription 必须存在；`rebate_status` 必须为 `pending`（不允许从 `none` 跳过来）；写入 `rebate_status='paid'`、`rebate_paid_at=now`、`rebate_note`。

#### `GET /admin/subscriptions?limit&offset`
返回全部订阅（按 `paid_at` 倒序），含 inviter 关系字段，admin 后台"全部订阅"标签页用。

### 4.3 Admin 静态页

```
GET /admin/{ADMIN_UI_PATH_SEGMENT}/  → 返回 admin.html（公开）
GET /admin/{ADMIN_UI_PATH_SEGMENT}/* → 静态资源
```

env `ADMIN_UI_PATH_SEGMENT` 默认 `ui-x9k2`，部署时改成更长随机串。最终 URL 形如 `https://...sh.run.tcloudbase.com/admin/ui-x9k2/`。

---

## 5. 配额奖励机制

### 5.1 扣减顺序
聊天发起时（`POST /chat`）扣减次数的逻辑改为：

```ts
// 伪代码
const limit = user.paid_until > now ? DAILY_LIMIT_PAID : DAILY_LIMIT_FREE
const todayUsed = await getDailyUsage(openid, today)

// decrementBonusAtomic 用条件 update：where bonus_balance > 0, $inc -1, 返回是否命中
const bonusConsumed = await decrementBonusAtomic(openid)
if (bonusConsumed) {
  // 已扣 1 点 bonus，放行
} else if (todayUsed < limit) {
  await incrementDailyUsage(openid, today)
} else {
  return 429 QUOTA_EXCEEDED
}
```

### 5.2 quota-badge 显示
```
今日 (limit - used) ＋ 奖励 N
e.g.  今日 7 / 10  ＋奖励 12
付费时：今日 27 / 30  ＋奖励 12
```

具体文案在 plan 阶段对照 Claude Design 微调。

### 5.3 触发奖励
仅在 `/invite/bind` 成功时触发，双方各 +`INVITE_REWARD_*`。**没有其他自动加 bonus 路径**（admin 页将来可加"手动赠送"按钮，本期不做）。

### 5.4 边界
- `bonus_balance` 不限上限（理论可累积，体验版规模无风险）
- 无过期机制（v1 简化；如出现刷邀请屯配额可后续加 30 天过期）

---

## 6. 邀请绑定规则

### 6.1 何时可绑
当且仅当：
- `users.inviter_openid == null`（一次终生）
- `users.paid_until == null`（未付费过）
- `now() - users.created_at < INVITE_BIND_WINDOW_DAYS` 天（默认 7）

### 6.2 触发路径
1. 分享者：`onShareAppMessage` 把 `path` 写为 `/pages/login/login?ic={my_invite_code}`
2. 接收者打开小程序：
   - 已经登录过的老用户：读 `options.ic` → 调 `/invite/bind`，按规则可能 `WINDOW_EXPIRED`/`ALREADY_BOUND`
   - 新用户首启：先存 `wx.setStorageSync('pending_ic', ic)` → 走完登录拿到 openid → 调 `/invite/bind` → 清掉 storage

### 6.3 防自邀
- `code → openid` 比对，等于 self → `SELF_INVITE`
- 接收者打开自己分享的链接（在自己手机上点了又点）会被拒，UI 不弹错（静默忽略）

---

## 7. 付费与返点流程（手动）

> 这是当前阶段（无微信支付）的运营动作。

```
[用户]
  在小程序 about 页看到"会员开通查询码" = openid 后 6 位
  微信转你 ¥20，备注查询码

[你]
  1. 比对 about 页查询码 → 找到完整 openid（admin 页"全部用户"未做，先用查询码足够）
     [简化：让用户在转账后在小程序里自报；admin 输入 openid 即可]
  2. admin 后台 → "录入付费" 表单 → 提交
  3. 后端写 subscription（rebate_status=pending 或 none）+ 更新 paid_until
  4. 用户次日打开小程序 → /user/me 返回 is_paid=true, today_limit=30
  
[隔几天]
  5. admin 后台 → "待返点" 标签 → 看到 N 条
  6. 微信转账给上级（金额你自己定，比如 ¥6.6）
  7. 点"标记已发返点" → 弹窗输入备注 → 提交
  8. 该条移到"已返点"标签

[未来接微信支付后]
  - "录入付费"被 wxpay 回调路由替代（同一段写订阅逻辑）
  - 返点流程不变（仍手动）
```

---

## 8. Admin 后台页

### 8.1 部署形态
- 单文件 `container/public/admin.html`（HTML + CSS + 内联 JS，约 300 行）
- 由 `@fastify/static` 在 `/admin/{ADMIN_UI_PATH_SEGMENT}/` 提供
- 同源调用 admin API，无 CORS

### 8.2 鉴权
- 页面公开（不含敏感数据）
- 顶部输入 `X-Admin-Token`，存 `localStorage`
- 所有 fetch 自动注入 header；无 token 不发请求

### 8.3 功能
四个 tab：

| Tab | 数据源 | 操作 |
|---|---|---|
| 待返点 | `GET /admin/rebates?status=pending` | "标记已发"按钮 → modal 输入 `rebate_note` → POST mark-paid |
| 已返点 | `GET /admin/rebates?status=paid` | 仅查看 |
| 全部订阅 | `GET /admin/subscriptions` | 仅查看，倒序 |
| 录入付费 | 表单 | POST /admin/mark-paid |

### 8.4 视觉
- 沿用小程序 Claude Design tokens（米白底 #f7f3ec、橙色强调 #e76f51、酒红次要、等宽数字）
- 不引入框架/构建工具，保持单文件可直接编辑

### 8.5 路径混淆
- 见 §10 `ADMIN_UI_PATH_SEGMENT`
- 不暴露 `/admin/` 根目录列表（只挂明确的 `/admin/{SEGMENT}/...` 静态资源 + 各 admin API 端点）；API 自带 token 鉴权

---

## 9. 前端改动

### 9.1 chat 页
- 实现 `Page.onShareAppMessage`：
  ```ts
  onShareAppMessage() {
    const ic = this.data.user?.invite_code
    return {
      title: '童锦程教你怎么搞定她',          // 文案 plan 阶段确认
      path: ic ? `/pages/login/login?ic=${ic}` : '/pages/login/login',
      imageUrl: '/assets/share-cover.png'      // 5:4，资源 plan 阶段交付
    }
  }
  ```

### 9.2 login 页
- `onLoad(options)`：
  ```ts
  if (options.ic && /^[A-Z0-9]{6}$/.test(options.ic)) {
    wx.setStorageSync('pending_ic', options.ic)
  }
  ```
- 登录拿到 openid 之后：
  ```ts
  const ic = wx.getStorageSync('pending_ic')
  if (ic) {
    const r = await api.bindInvite(ic)
    wx.removeStorageSync('pending_ic')
    if (r.ok) {
      // toast: 已通过邀请获得 +5 奖励配额
    }
    // 失败静默；用户感知不到
  }
  ```

### 9.3 about 页
新增三块：
- **我的会员**：免费 vs 付费状态条；付费显示"有效期至 YYYY-MM-DD"
- **会员开通查询码**：openid 后 6 位（明文展示，用于转账备注）
- **我的邀请码 + 邀请按钮**：显示邀请码，引导"点右上角 ··· 转发给好友"

### 9.4 quota-badge
- 改显示逻辑：`today X / Y` + 若 `bonus_balance > 0` 追加 `+奖励 N`

### 9.5 utils/api.ts
新增方法：
```ts
api.getMe()                              // 已有 /user/me，更新返回类型
api.bindInvite(code: string)
```

---

## 10. 环境变量

新增（**部署前必须在 CloudBase 控制台配置**）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | (无默认) | 32 位以上随机串；缺失时 admin API 全部 503 |
| `ADMIN_UI_PATH_SEGMENT` | `ui-x9k2` | admin 页路径段（位于 `/admin/` 之下），部署时改成更长随机串 |
| `INVITE_REWARD_INVITER` | `5` | 邀请人 bind 成功获得的 bonus |
| `INVITE_REWARD_INVITEE` | `5` | 被邀请人 bind 成功获得的 bonus |
| `INVITE_BIND_WINDOW_DAYS` | `7` | 注册后多少天内可绑定 |
| `DAILY_LIMIT_FREE` | `10` | 免费用户每日基础额度 |
| `DAILY_LIMIT_PAID` | `30` | 付费用户每日基础额度 |
| `SUBSCRIPTION_AMOUNT` | `20` | 标准订阅金额（仅 admin 表单默认值用，不强制） |
| `SUBSCRIPTION_PERIOD_DAYS` | `30` | 一个订阅周期天数 |

---

## 11. 安全与防刷

| 风险 | 防御 |
|---|---|
| 自邀获奖励 | `inviter_openid != self` 校验 |
| 反复绑定换上级 | `inviter_openid` 一次写入终生不可改 |
| 老用户回头绑高返点上级 | 7 天 + 未付费 双窗口 |
| 邀请码暴力枚举 | 32^6 空间 + 后端无限速属边界（v1 暂不加 rate-limit；如发现攻击再加 IP / openid 维度限流） |
| admin 接口暴露 | `X-Admin-Token` env 必填；token 缺失或不匹配 → 403 |
| admin 页被无意爬到 | 路径含随机后缀（`ADMIN_UI_PATH_SUFFIX`） |
| openid 隐私 | 永不出现在分享 path 里（用 `invite_code` 中转） |
| bonus_balance 成负 | 写入用条件 `bonus_balance > 0` 才扣，避免并发负值 |

---

## 12. 涉及文件清单（在 `~/Desktop/love-train-mp/`）

```
container/
  public/
    admin.html                           ← 新建
  src/
    server.ts                            ← 注册 @fastify/static + admin 路由
    config.ts                            ← 加新增 env 读取
    middleware/
      admin.ts                           ← 新建：X-Admin-Token 校验
    routes/
      invite.ts                          ← 新建：/invite/bind
      admin.ts                           ← 新建：/admin/mark-paid 等
      user.ts                            ← 改：/user/me 返回新字段
      chat.ts                            ← 改：扣 bonus 优先 + 用动态 limit
    db/
      cloudbase-adapter.ts               ← 加 invite/subscription 方法
      adapter.ts                         ← 接口加方法签名
      mongo-adapter.ts                   ← 测试 stub 跟进
    utils/
      invite-code.ts                     ← 新建：生成 + 校验
  package.json                           ← +@fastify/static

miniprogram/
  pages/
    chat/chat.ts                         ← onShareAppMessage
    login/login.ts                       ← onLoad ic + 登录后 bind
    about/about.{wxml,wxss,ts}           ← 我的会员 + 邀请码
  components/
    quota-badge/                         ← 显示 bonus_balance
  utils/
    api.ts                               ← +bindInvite, 改 getMe 返回类型
    consts.ts                            ← 加邀请相关常量

docs/
  specs/2026-05-03-invite-and-subscription-design.md   ← 本文件
```

---

## 13. 测试要点

### 后端单测（vitest，跑在 mongo-adapter）
- invite-code 生成无碰撞（采样 1 万次）
- `/invite/bind` 五种失败码各覆盖一例
- `/invite/bind` 成功路径双方 bonus_balance 各 +5
- `/admin/mark-paid` 有/无 inviter 两种 rebate_status
- `/admin/rebates/:id/mark-paid` 状态机：仅 `pending → paid` 允许
- chat 扣减优先 bonus → daily_usage

### 模拟器手测
- A 账号生成邀请码 → 复制分享路径
- 微信开发者工具切换 B 账号 → 通过自定义编译条件传 `ic=A_CODE` → 登录后两边 bonus 各 +5 ✓
- B 改时间机：`created_at` 改成 8 天前再尝试 bind → `WINDOW_EXPIRED` ✓
- B 调 `/admin/mark-paid` → 次日 about 页显示付费 ✓
- 模拟连续发 30 条消息（付费）+ 5 bonus → 35 条都通过；第 36 条 429 ✓

### admin 页手测
- 错 token → 列表为空，不报敏感信息
- 正确 token → 待返点列表展示完整
- 标记已发后 → pending 列表少一行，paid 列表多一行
- 录入付费 → /user/me 立刻反映

---

## 14. 未来工作（不在本期范围）

| 项 | 触发时机 | 大致方向 |
|---|---|---|
| 微信支付集成 | 主体改个体工商户 + JSAPI 支付能力开通 | 新加 `/wxpay/notify` 路由，复用 `mark-paid` 内部函数 |
| 广告渲染 | 引入广告 SDK 时 | chat 页基于 `is_paid` 决定渲染 banner / 插屏 |
| 邀请人战绩页 | 邀请规模上量 | 小程序内"我的邀请"页，调 `/user/me/referrals` |
| 邀请奖励过期 | 出现刷邀请屯额度 | bonus 加 `granted_at`，30 天滚动过期 |
| Bonus 手动赠送 | 客服需求 | admin 页"补偿用户"操作 |

---

## 15. 进入实施

下一步：在 `docs/plans/` 下生成 implementation plan（按 task 切分，TDD 顺序）。
