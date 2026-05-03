# love-train 小程序 · 邀请关系 + 配额奖励 + 付费 + 返点 设计（v2）

> 状态：草案 v2 · 日期 2026-05-03 · 关联 [`docs/handoff.md`](../handoff.md)
>
> v2 相较 v1 改动：去掉手动开通码 / `/admin/mark-paid` 路径，改用真·微信支付 JSAPI v3 + 测试用 mock 模式。

---

## 1. 这个 spec 在解决什么

把小程序从「免费聊」升级为「免费 + 付费 + 邀请裂变」三件事，并且做成**用户感受不到任何手动操作**：

| 用户场景 | 用户感受 |
|---|---|
| 我要分享给朋友 | 点右上角"转发"，没了 |
| 朋友打开后第一次登录 | 系统**自动**识别"我是被你邀请的"，双方各 +5 次免费查询，弹一个 toast |
| 我想升级付费版 | 「关于」页点「开通 ¥20/月」→ 弹微信支付 → 付完立刻变付费版 |
| 付费成功后我朋友返点 | 系统**自动**记录"这笔钱有上级"，我（运营）在 admin 后台看待返点列表，手动转账并标记 |

**当前微信主体是个人，没法接微信支付**。这一版按"假定主体已经是个体工商户"来设计代码（按官方 v3 接口实现），但提供 **mock 模式**让你今天就能测 UI / 功能 / 数据流的全套闭环。等主体迁移完成 + 拿到商户号，**改一个 env 变量** `WXPAY_MODE=real` 即可切到真支付，不用改任何代码。

---

## 2. 范围

### 范围内
- 邀请关系绑定（小程序内分享 → 自动识别上级 → 首次登录绑定）
- 持久奖励配额（双方各 +5 次免费查询，扣消息时优先扣这个）
- 付费 / 免费每日额度差异化（10 / 30）+ `is_paid` flag（未来给广告系统门控用）
- 微信支付 JSAPI v3 完整接入（按官方文档）
- Mock 模式：env 切换，不调真 wxpay 接口，本地直接走"已付费"路径
- 微信支付异步通知（notify）→ 自动写订阅、自动标记返点状态
- 静态 admin 后台页：查待返点 / 已返点 / 全部订阅 / 用户邀请关系
- 数据库字段 + 订阅表
- 防刷规则（自邀、重绑、回头补绑老用户上级）

### 不做（YAGNI）
- ❌ 多级分销（仅 1 层 inviter）
- ❌ 邀请海报 / 朋友圈定制图 / 排行榜
- ❌ 小程序内"我的邀请战绩"页（不给邀请人看）
- ❌ 退款流程 UI（手动改 DB）
- ❌ 自动给上级转返点（永远手动）
- ❌ 内置广告 SDK（仅在 `/user/me` 暴露 `is_paid` 给前端将来用）
- ❌ 订阅续费提醒 / 自动续费（v1 一笔一笔买）

---

## 3. 数据要存什么（业务语言）

### 3.1 每个用户身上多记 5 项

| 业务含义 | 字段名 | 类型 / 默认 | 说明 |
|---|---|---|---|
| 我的邀请码 | `invite_code` | string(6) | 注册时自动生成，6 位字母数字。**用户看不到这个东西**，它藏在分享链接里 |
| 是谁邀请了我 | `inviter_openid` | string \| null | 绑定一次永远不变。空 = 没人邀请我 |
| 被邀请时间 | `invited_at` | Date \| null | 用于审计 |
| 我还剩几次免费查询奖励 | `bonus_balance` | int ≥ 0，默认 0 | 发消息时优先扣这个，扣完才计入每日 10/30 限额 |
| 我的付费有效期 | `paid_until` | Date \| null | `> now()` 即视为付费用户。null 表示从没付过 |

### 3.2 每笔付费产生一行"订阅记录"（新表 `subscriptions`）

每行长这样：

| 业务含义 | 字段 | 说明 |
|---|---|---|
| 谁付的钱 | `openid` | |
| 当时他的上级是谁 | `inviter_openid` | **写入即冻结**，将来关系怎么变这一笔账归属不变 |
| 付了多少钱 | `amount` | 整数，单位"分"（微信支付要求），20 元 = 2000 |
| 付款时间 / 服务起止 | `paid_at` / `period_start` / `period_end` | |
| 微信支付订单号 | `transaction_id` | 微信返的，唯一 |
| 我们生成的订单号 | `out_trade_no` | 我们自己生成的，下单时用 |
| 来源 | `source` | `'wxpay'` 或 `'mock'`（mock 模式生成的订阅打 mock 标，admin 后台一眼能区分） |
| 返点状态 | `rebate_status` | `'none'`（无上级）/ `'pending'`（有上级，待你转钱）/ `'paid'`（你转过了） |
| 你转账后的备注 | `rebate_note` | 自由文本："¥6.6 微信转账给王五 备注 xxx" |
| 你转账时间 | `rebate_paid_at` | |

### 3.3 既有的 `daily_usage` 表不动结构，只改语义

`{ openid, date, used }` 不变。原本扣减条件硬编码是 `used < 10`，改成 `used < 当前用户的每日上限`：
- 付费用户（`paid_until > now()`）→ 30
- 否则 → 10

---

## 4. 用户体验流程（按场景）

### 4.1 邀请绑定（完全无感）

A 是老用户，B 是新用户：

1. A 在小程序里点右上角「···」→「转发给朋友」→ 选 B
   - A 啥也没做，他的邀请码已经被偷偷塞进分享卡
2. B 收到聊天里的小程序卡，点开
   - 小程序启动，**在打开瞬间从分享链接里读到 A 的邀请码**
   - B 完全感觉不到
3. B 点登录 → 微信授权 → 后端拿到 B 的 openid
   - 系统自动绑定："B 的上级是 A"
   - 两边各 +5 次奖励配额
   - B 看到 toast：「已通过邀请获得 +5 次免费查询」
4. 整个过程 B **没有输入任何东西**

### 4.2 付费开通（也完全无感）

C 已经登录了，今天想开通付费：

1. C 在「关于」页看到「开通付费版 ¥20/月」按钮
2. 点击 → 后端调微信支付下单接口拿到 `prepay_id` → 返回小程序
3. 小程序自动调起微信支付收银台（`wx.requestPayment`）
4. C 输支付密码 / 指纹 → 付款成功
5. 大约 1–3 秒内，**微信服务器给我们后端发回调通知**
6. 我们解密通知 → 验签 → 写订阅记录 → 更新 `paid_until` → 自动判断有没有上级 → 设置返点状态
7. C 回到小程序，「关于」页显示「付费会员 · 有效期至 2026-06-03」，每日额度从 10 变 30 ✅

**测试模式下（mock）**：
- 步骤 2-3 跳过，后端直接走"已付费"路径，前端弹 modal「已模拟开通付费（测试模式）」
- 数据库里这条订阅 `source='mock'`
- 这样你今天就能完整测一遍 UI、扣减逻辑、admin 后台显示

### 4.3 你（运营）的日常返点动作

每周 / 每月：

1. 浏览器打开 admin 后台 → 输 token → 进去
2. 点「待返点」标签 → 看到列表：
   ```
   王五 ← 李四付费 ¥20 · 5月3日
   赵六 ← 张三付费 ¥20 · 5月5日
   ```
3. 微信打开，转钱给王五（金额你自己定，¥6.6 / ¥10 都行）
4. admin 页面点王五那行的「标记已发返点」→ 弹窗输入 `¥6.6 微信转账 5月10日` → 提交
5. 这条挪到「已返点」标签

> 程序不规定返点比例 / 金额，都是你手动决定，后台只负责"记录关系 + 标记状态"。

---

## 5. 后端接口设计

### 5.1 用户态（既有 openid 中间件鉴权）

#### `GET /user/me`（既有路由扩展）

返回新加 5 个字段：

```jsonc
{
  // 既有
  "openid": "oXxx...",
  "today_used": 3,
  // 改动
  "today_limit": 10,         // 动态：付费 30，免费 10
  // 新增
  "is_paid": false,
  "paid_until": null,        // ISO 8601 或 null
  "invite_code": "A8K2P9",
  "inviter": null,           // { invite_code: "B3M7Q1" } 已绑定时
  "bonus_balance": 5
}
```

#### `POST /invite/bind`

```jsonc
// req
{ "code": "B3M7Q1" }

// res 200
{ "ok": true, "bonus_added": 5 }

// res 400
{ "ok": false, "error": "SELF_INVITE" | "ALREADY_BOUND" | "WINDOW_EXPIRED" | "CODE_NOT_FOUND" | "INVALID_CODE_FORMAT" }
```

绑定规则（命中任一即拒）：
- `code` 不存在 / 格式错 → `CODE_NOT_FOUND` / `INVALID_CODE_FORMAT`
- `code` 对应 self → `SELF_INVITE`
- 当前 user 已有 inviter_openid → `ALREADY_BOUND`
- 当前 user `paid_until != null` 或注册超 `INVITE_BIND_WINDOW_DAYS` 天 → `WINDOW_EXPIRED`

成功后两步幂等更新：
1. 当前 user：`inviter_openid = X, invited_at = now, bonus_balance += INVITE_REWARD_INVITEE`（条件 `inviter_openid == null`）
2. inviter：`bonus_balance += INVITE_REWARD_INVITER`

> CloudBase NoSQL 不支持多文档事务。第二步失败几率极低，失败时仅日志告警 + 写补偿队列（v1 仅日志，运维侧手动修复）。

#### `POST /payment/create-order` ★ 新增

前端点「开通付费」按钮调用。

```jsonc
// req
{ "months": 1 }                       // 默认 1，预留多月一次性付

// res 200 (real 模式)
{
  "mode": "real",
  "wx_payment": {
    "timeStamp": "1714766400",
    "nonceStr": "...",
    "package": "prepay_id=...",
    "signType": "RSA",
    "paySign": "..."
  }
}

// res 200 (mock 模式)
{
  "mode": "mock",
  "subscription_id": "...",
  "paid_until": "2026-06-03T..."
}

// res 4xx
{ "ok": false, "error": "INTERNAL_WXPAY_FAILED" | "RATE_LIMITED" }
```

**real 模式后端逻辑**：
1. 生成 `out_trade_no`（如 `LT{yyyymmddhhmmss}{rand6}`，存入返回的 prepay 上下文）
2. 调 `https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi`，必传字段：
   - `appid` = 小程序 AppID
   - `mchid` = 商户号
   - `description` = `'love-train 付费会员（1 个月）'`
   - `out_trade_no`
   - `notify_url` = `https://<容器域名>/wxpay/notify`
   - `amount.total` = `SUBSCRIPTION_AMOUNT_CENTS`（默认 2000）
   - `payer.openid` = 当前用户 openid
3. 拿到 `prepay_id`，构造 `wx.requestPayment` 五字段：
   - `timeStamp` = 当前秒级时间戳
   - `nonceStr` = 32 位随机
   - `package` = `'prepay_id=' + prepay_id`
   - `signType` = `'RSA'`
   - `paySign` = 用商户私钥 RSA-SHA256 签名 `appId\ntimeStamp\nnonceStr\npackage\n`，base64
4. 返回前端

> 不做 pending_payments 表（YAGNI）：防重复靠前端按钮按下立刻 disable + 后端开 60s 内同 openid 限流（`RATE_LIMITED`）；订单一致性靠 `transaction_id` 唯一索引在 notify 时去重。如果出现"用户付了钱但 notify 一直没到"的极端场景，未来加 wxpay 主动查询 API 兜底。

**mock 模式后端逻辑**：
1. 跳过 wxpay API
2. 直接走 `recordPayment(openid, amount, source='mock')` 内部函数（同 `/wxpay/notify` 用的同一函数）
3. 返回 `{ mode: 'mock', subscription_id, paid_until }`

#### `POST /wxpay/notify` ★ 新增（微信回调）

微信支付服务器在用户付款成功后异步 POST 来。

**请求头**：
- `Wechatpay-Signature` / `Wechatpay-Serial` / `Wechatpay-Timestamp` / `Wechatpay-Nonce`

**请求体**（外层）：
```jsonc
{
  "id": "...",
  "create_time": "...",
  "event_type": "TRANSACTION.SUCCESS",
  "resource_type": "encrypt-resource",
  "resource": {
    "algorithm": "AEAD_AES_256_GCM",
    "ciphertext": "...",
    "associated_data": "transaction",
    "nonce": "..."
  }
}
```

**处理步骤**：
1. **验签**：用微信支付平台公钥（v3 平台证书 / 平台公钥）验证 `Wechatpay-Signature` 是否合法。验签失败 → 返 401，记日志，不进数据库
2. **解密**：用 APIv3 密钥 + AEAD_AES_256_GCM + nonce + associated_data 解密 `ciphertext`，得到原始通知 JSON：
   ```jsonc
   {
     "out_trade_no": "LT...",
     "transaction_id": "...",
     "trade_state": "SUCCESS",
     "payer": { "openid": "..." },
     "amount": { "total": 2000, "payer_total": 2000, "currency": "CNY" }
   }
   ```
3. **幂等检查**：根据 `transaction_id` 查 `subscriptions`，已存在 → 直接返成功（防止微信重复回调）
4. **写订阅** + **更新 user.paid_until**：调内部 `recordPayment(openid, amount, transaction_id, out_trade_no, source='wxpay')`
5. **必返**：`200 + { code: "SUCCESS", message: "OK" }`，否则微信会按指数退避重试最多 8 次（24h 内）

> 用 `wechatpay-node-v3-ts` SDK 处理验签 / 解密：`pay.verifySign(headers, body)` + `pay.decipher_gcm(...)`。**不要自己写 RSA / AES**，错一字节就过不了。

### 5.2 Admin 接口（`X-Admin-Token` header 鉴权）

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/admin/rebates?status=pending\|paid` | 列待返点 / 已返点 |
| `POST` | `/admin/rebates/:subscription_id/mark-paid` | body `{ rebate_note }`，标记已发返点 |
| `GET` | `/admin/subscriptions?limit&offset` | 全部订阅倒序，含 source = wxpay / mock 标记 |
| `GET` | `/admin/users?invite_code=&openid=` | 查用户邀请关系（用于核对） |
| `GET` | `/admin/users/:openid/referrals` | 这个用户邀请了哪些人 |

> **没有** `/admin/mark-paid`（v1 里有，v2 删了）— 付费一律走 wxpay 通道（real 或 mock）。

### 5.3 Admin 静态页

```
GET /admin/{ADMIN_UI_PATH_SEGMENT}/         返回 admin.html
GET /admin/{ADMIN_UI_PATH_SEGMENT}/*         静态资源
```

env `ADMIN_UI_PATH_SEGMENT` 默认 `ui-x9k2`，部署时改更长随机串。

---

## 6. 配额扣减机制

`POST /chat` 入口扣次数的逻辑改为：

```
limit = (user.paid_until > now) ? DAILY_LIMIT_PAID : DAILY_LIMIT_FREE
todayUsed = daily_usage 表查今天

// 原子条件 update：where bonus_balance > 0, $inc -1，返回是否命中
bonusConsumed = decrementBonusAtomic(openid)

if (bonusConsumed) {
  // 已扣 1 点 bonus，放行
} else if (todayUsed < limit) {
  incrementDailyUsage(openid, today)  // 既有逻辑
} else {
  return 429 QUOTA_EXCEEDED
}
```

**前端 quota-badge 显示**：`今日 X / 限额` + 若 `bonus_balance > 0` 追加 `+奖励 N`。

---

## 7. 邀请触发路径（前端）

### 7.1 chat 页 — 实现 `onShareAppMessage`

```ts
onShareAppMessage() {
  const ic = this.data.user?.invite_code
  return {
    title: '童锦程教你怎么搞定她',
    path: ic ? `/pages/login/login?ic=${ic}` : '/pages/login/login',
    imageUrl: '/assets/share-cover.png'
  }
}
```

> 文案 + 分享卡图在 plan 阶段确认，不在本 spec。

### 7.2 login 页 — `onLoad` 读 ic

```ts
onLoad(options) {
  if (options.ic && /^[A-Z0-9]{6}$/.test(options.ic)) {
    wx.setStorageSync('pending_ic', options.ic)
  }
}
```

登录拿到 openid 之后：
```ts
const ic = wx.getStorageSync('pending_ic')
if (ic) {
  const r = await api.bindInvite(ic)
  wx.removeStorageSync('pending_ic')
  if (r.ok) wx.showToast({ title: `已通过邀请 +${r.bonus_added} 次` })
  // 失败静默
}
```

### 7.3 about 页

新增三块：

1. **我的会员状态**
   - 免费版：「免费会员 · 每日 10 次」+ 显眼的「开通付费版 ¥20/月」按钮
   - 付费版：「付费会员 · 每日 30 次 · 有效期至 YYYY-MM-DD」+ 灰一点的「续费」按钮（也调 `/payment/create-order`）

2. **邀请好友**
   - 显示「我的邀请码 A8K2P9」（仅展示，**不引导用户口头传播**）
   - 一行说明：「点右上角 ··· 转发给朋友，对方登录后双方各 +5 次免费查询」

3. （已有）清空对话按钮

### 7.4 付费按钮处理

```ts
async tapSubscribe() {
  const r = await api.createOrder({ months: 1 })
  if (r.mode === 'mock') {
    wx.showModal({ title: '已模拟开通（测试模式）', content: `有效期至 ${r.paid_until}` })
    this.refreshMe()
    return
  }
  // real 模式
  wx.requestPayment({
    ...r.wx_payment,
    success: () => {
      // 微信侧确认完成，但 paid_until 由 notify 回调写入
      // 前端轮询 /user/me 1 次（最多 3 次，间隔 1s）等回调到位
      this.pollPaidStatus()
    },
    fail: (err) => { /* user cancelled or pay failed */ }
  })
}
```

---

## 8. 微信支付前置条件（你那边的事）

> 等你主体迁移完成 + 申请下来 + 我们这边换 env 之后才生效。**代码不依赖这些就位才能开发，靠 mock 模式跑测试**。

| 项 | 你需要做的 |
|---|---|
| 主体 | 个人 → 个体工商户（小程序后台「设置 → 基本设置 → 主体类型」迁移，约 30 天） |
| 微信支付商户号 | https://pay.weixin.qq.com 申请（个体工商户主体下 3-7 天） |
| 商户号 ↔ AppID 绑定 | 商户后台「产品中心 → AppID 账号管理 → 关联 AppID」 |
| 商户 API 证书 | 商户后台「账户中心 → API 安全 → 申请 API 证书」，下载 `apiclient_cert.pem` + `apiclient_key.pem` |
| APIv3 密钥 | 商户后台「账户中心 → API 安全 → 设置 APIv3 密钥」，自定义 32 位字符串 |
| 平台证书 | 用 SDK 自动下载平台证书（首次启动时拉取，缓存到容器） |
| JSAPI 授权目录 | 商户后台配置：`https://<容器域名>/payment/`（前端调起页所在 path 的目录） |
| notify_url 域名 | 配置在商户后台 + 部署到 HTTPS 域名（云托管自带）|
| 小程序 request 合法域名 | `https://api.mch.weixin.qq.com` 加到小程序后台「服务器域名」 |

---

## 9. env 配置（部署前必填）

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_TOKEN` | (无默认) | admin 后台 token，32 位以上随机串 |
| `ADMIN_UI_PATH_SEGMENT` | `ui-x9k2` | admin 页 URL 段，部署时改长 |
| `INVITE_REWARD_INVITER` | `5` | 邀请人成功带来一个绑定，获得几次奖励 |
| `INVITE_REWARD_INVITEE` | `5` | 被邀请人成功绑定，获得几次奖励 |
| `INVITE_BIND_WINDOW_DAYS` | `7` | 注册后多少天内可绑定上级 |
| `DAILY_LIMIT_FREE` | `10` | 免费用户每日基础查询次数 |
| `DAILY_LIMIT_PAID` | `30` | 付费用户每日基础查询次数 |
| `SUBSCRIPTION_AMOUNT_CENTS` | `2000` | 一笔订阅金额（分），20 元 = 2000 |
| `SUBSCRIPTION_PERIOD_DAYS` | `30` | 一笔订阅顶几天 |
| **`WXPAY_MODE`** | `mock` | `mock` \| `real`，控制是否走真支付 |
| `WXPAY_APPID` | (real 模式必填) | 小程序 AppID（与 `app.json` 一致） |
| `WXPAY_MCHID` | (real 模式必填) | 商户号 |
| `WXPAY_API_V3_KEY` | (real 模式必填) | APIv3 密钥（32 位字符串） |
| `WXPAY_CERT_SERIAL` | (real 模式必填) | 商户证书序列号 |
| `WXPAY_PRIVATE_KEY_PATH` | (real 模式必填) | 商户私钥文件路径，容器内挂载 |
| `WXPAY_NOTIFY_URL` | (real 模式必填) | `https://<container-domain>/wxpay/notify` |

---

## 10. 安全与防刷

| 风险 | 防御 |
|---|---|
| 自邀获奖励 | `inviter_openid != self` |
| 反复绑换上级 | `inviter_openid` 一次写入终生不可改 |
| 老用户回头补绑高返点上级 | 7 天 + 未付费 双窗口（命中即拒 `WINDOW_EXPIRED`） |
| 邀请码暴力枚举 | 字母数字组合 32^6 ≈ 10 亿，未来有量再加 IP 限流 |
| openid 出现在分享 path | 不会，只用 `invite_code` 中转 |
| bonus_balance 并发负值 | 原子条件 update（`where bonus_balance > 0, $inc -1`） |
| admin 接口被探测 | `X-Admin-Token` 必填，缺失 / 不匹配 → 403；admin 静态页路径含随机后缀 |
| **wxpay 回调伪造** | `Wechatpay-Signature` 必须用平台证书验签通过；验签失败 → 401 不写库 |
| **wxpay 回调重放** | `transaction_id` 唯一索引 + 幂等查询 |
| **mock 模式被打到生产** | `WXPAY_MODE=real` 时强制要求 `WXPAY_*` 全套 env 齐全；缺失则启动失败 |
| **mock 订阅被误认为真订单** | `subscriptions.source = 'mock' \| 'wxpay'`，admin 页明确标记 |
| API 证书 / 私钥泄露 | 私钥不进 git，CloudBase 部署时挂载到容器 `/secrets/` |

---

## 11. 测试要点

### 11.1 mock 模式（今天就能跑）
- [ ] A 邀请 B：B 走完登录后 `/user/me` 显示 `bonus_balance=5`，inviter 字段非空
- [ ] A 也 `bonus_balance=5`
- [ ] A 已注册 8 天 + 未付费，再点别人分享 → `WINDOW_EXPIRED`
- [ ] B 已经被 X 邀请过，再点 A 的分享 → `ALREADY_BOUND`
- [ ] A 自己点自己分享的链接 → `SELF_INVITE`
- [ ] C 在 about 页点「开通付费」→ modal 弹「已模拟开通」→ `paid_until` 写入 → 每日额度变 30
- [ ] admin 后台「全部订阅」看到这条 source = mock
- [ ] C 有上级，admin「待返点」列表能看到
- [ ] 点「标记已发」+ 备注 → 挪到「已返点」
- [ ] chat 页发消息：先消耗 bonus_balance 5 次，再算 daily_usage

### 11.2 real 模式（商户号到位后）
- [ ] 沙箱环境把 `WXPAY_MODE=real` + 配齐 wxpay env，真机测付款
- [ ] 验签失败手动构造（错误 sig）→ /wxpay/notify 返 401
- [ ] 重复回调（同一 transaction_id）→ 幂等返 200，不写第二行订阅
- [ ] 付费 + notify 到达后 1-3 秒内 `/user/me` 反映 `is_paid=true`

### 11.3 单元测试（vitest，跑在 mongo-adapter）
- invite-code 生成无碰撞（采样 1 万次）
- `/invite/bind` 五种失败码各一例
- `/invite/bind` 成功路径双方 +5
- `recordPayment` 内部函数：mock 与 wxpay 两种 source，inviter 有 / 无两种 rebate_status
- `/admin/rebates/:id/mark-paid` 状态机：仅 `pending → paid` 允许
- chat 扣减：bonus 优先 → daily_usage

---

## 12. Admin 后台页（功能清单）

单文件 `container/public/admin.html`，HTML+CSS+JS 一体，约 300-400 行，由 `@fastify/static` 在 `/admin/{ADMIN_UI_PATH_SEGMENT}/` 提供。同源调用 admin API，无 CORS。

页面顶部输入 token，存 localStorage。五个 tab：

| Tab | 数据源 | 操作 |
|---|---|---|
| 待返点 | `GET /admin/rebates?status=pending` | 「标记已发」按钮 → modal 输 `rebate_note` → POST mark-paid |
| 已返点 | `GET /admin/rebates?status=paid` | 仅查看，含 `rebate_paid_at` + `rebate_note` |
| 全部订阅 | `GET /admin/subscriptions` | 倒序，每行明确标记 source = wxpay / **mock** |
| 用户查询 | `GET /admin/users?...` | 输 invite_code 或 openid 查用户 + 看他邀请了谁 |
| 系统状态 | 静态展示 + `GET /admin/health`（new） | 显示当前 `WXPAY_MODE`、env 是否齐全、最近 1h 订阅数 |

视觉沿用小程序 Claude Design tokens：米白底 #f7f3ec、橙色强调 #e76f51、酒红次要、等宽数字。

---

## 13. 涉及文件改动清单（在 `~/Desktop/love-train-mp/`）

```
container/
  package.json                              ← +@fastify/static, +wechatpay-node-v3-ts
  public/
    admin.html                              ← 新建
  src/
    server.ts                               ← 注册 @fastify/static + wxpay 路由
    config.ts                               ← 新增 env 读取 + 启动期 mode/env 校验
    middleware/
      admin.ts                              ← 新建：X-Admin-Token 校验
    routes/
      invite.ts                             ← 新建：/invite/bind
      payment.ts                            ← 新建：/payment/create-order
      wxpay.ts                              ← 新建：/wxpay/notify
      admin.ts                              ← 新建：/admin/rebates 等
      user.ts                               ← 改：/user/me 加新字段
      chat.ts                               ← 改：扣减优先 bonus + 动态 limit
    services/
      payment.ts                            ← 新建：recordPayment + WxpayClient + mock 分支
      invite.ts                             ← 新建：bindInvite 业务逻辑
    db/
      cloudbase-adapter.ts                  ← 加 invite/subscription/payment 方法
      adapter.ts                            ← 接口加方法签名
      mongo-adapter.ts                      ← 测试 stub 跟进
    utils/
      invite-code.ts                        ← 新建：生成 + 校验
      wxpay-sign.ts                         ← 新建：仅放 paySign 拼装（验签解密走 SDK）

miniprogram/
  pages/
    chat/chat.ts                            ← onShareAppMessage
    login/login.ts                          ← onLoad ic + 登录后 bind
    about/about.{wxml,wxss,ts}              ← 我的会员 + 邀请码 + 开通付费按钮
  components/
    quota-badge/                            ← 显示 bonus
  utils/
    api.ts                                  ← +bindInvite, +createOrder, 改 getMe
    consts.ts                               ← 加邀请相关常量

docs/
  specs/2026-05-03-invite-and-subscription-design.md   ← 本文件
```

---

## 14. 上线后切真支付的 checklist

> 这部分是给"未来某天"用的备忘，不在 plan 阶段执行。

1. 主体迁移到个体工商户（30 天审核）
2. 在 https://pay.weixin.qq.com 申请商户号（3-7 天）
3. 商户号关联 AppID（即时）
4. 下载 API 证书 + 设置 APIv3 密钥
5. CloudBase 控制台改 env：
   - `WXPAY_MODE` = `mock` → `real`
   - 填齐 `WXPAY_*` 七个变量
   - 把 `apiclient_key.pem` 上传到容器（云托管「文件管理」或 Dockerfile 里 COPY）
6. 商户后台配置 JSAPI 授权目录 + notify_url
7. 小程序后台「服务器域名」加 `https://api.mch.weixin.qq.com`
8. 重新部署容器
9. 真机沙箱测一笔（1 分钱）
10. 把测试订阅记录从 DB 删掉（或保留，反正 source=mock 一目了然）

---

## 15. 进入实施

下一步：在 `docs/plans/` 下生成 implementation plan，按 task 切分（建议按依赖顺序）：

1. **Task 1**：DB schema + invite-code utils
2. **Task 2**：`/invite/bind` + `/user/me` 扩展 + chat 扣减逻辑
3. **Task 3**：mock 模式 `/payment/create-order` + `recordPayment` + 订阅写入
4. **Task 4**：`/wxpay/notify` + 验签解密 SDK 接入（real 路径，但 mock 模式不触发）
5. **Task 5**：admin 路由 + admin.html
6. **Task 6**：前端 chat / login / about / quota-badge
7. **Task 7**：联调 mock 模式全链路 + 单测

每个 task 独立可测，可分 PR。
