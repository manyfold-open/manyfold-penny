# Penny

[English](README.md) · 中文

Penny 是一只帮群聊记账、分账的柯基。朋友们用平常说话的方式告诉她花了什么钱，她负责记下来、
算出谁欠谁，并帮大家结清。她是一个 [Manyfold](https://manyfold.ai) agent，背后是一套跑在
Cloudflare Workers 和 D1 上的账本。

```
Zack   @Penny 晚餐 Dishoom 120 我付，四個人分
Penny  晚餐 Dishoom £120，Zack 付
       均分 4 人，每人 £30
       回 @Penny OK 入帳，或直接說要改什麼
Mei    @Penny OK
Penny  已入帳 #21 晚餐 Dishoom £120
Ken    @Penny 誰欠誰
Penny  Mei → Zack £175
       Ken → Zack £35
```

对方用什么语言，Penny 就用什么语言回答：繁体中文、简体中文或英文。

## Penny 能做什么

- **一句话记账。** 均分、指定金额、按百分比、按份数、按收据逐项分摊、个人加减（“Ken 不喝酒，
  少算他 8”）、代垫、退款，以及不在群里的客人。
- **先确认，再入账。** 每一笔支出、修改、删除和还款都只是提案，群里有人回 OK 才算数。
  还款只能由收到钱的人确认。
- **算出谁欠谁。** 给出每个人的净额，以及转账笔数尽量少的结清方案。可以分次还款。
- **回答账本相关的问题。** 最近记了什么、某个人付了多少与应分摊多少、按类别和按天的合计。
- **画卡片。** 超过三行的内容会以 PNG 卡片发出，数据直接取自账本：谁欠谁、逐项收据、
  行程海报、按类别的花费、每天的花费、最近的支出。
- **记住群的习惯。** “Ken 每次都不算酒钱”会按群记下来（每个群最多 20 条），之后的提案会
  照此处理，并且 Penny 会说明她用了这条习惯。
- **群与群互不相通。** 一个聊天室一本账。在私聊里，一个人可以查自己在所有群里的总体情况，
  别人查不到。

Penny 自己从不做金额运算。每一个金额、分摊和余额都来自账本；账本以货币的最小单位
（便士、分、日元）的整数计算，不使用浮点数。

## 整体结构

```
群聊
   │  每条消息都带上房间、发言人、成员和时间
   ▼
Manyfold 上的 Penny agent        agent/PENNY.md       她的规则
   │                             agent/bin/penny.mjs  她调用的账本工具
   │                             agent/cards/         卡片渲染（SVG → PNG）
   │  HTTPS，Authorization: Bearer <PENNY_API_KEY>
   ▼
Cloudflare Worker (Hono)         src/worker/ledger/   /api/ledger/*
   ▼
D1                               群、成员、支出、付款人、分摊、
                                 还款、记忆、收款方式
```

这个 Worker 同时提供一个小型网页应用（React），可以在浏览器里连接 Manyfold agents 并与之
聊天。它来自本仓库所基于的
[Cloudflare Worker Starter for Manyfold Agents](https://github.com/manyfold-open/cloudflare-worker-starter)，
适合用来确认 agent 是否正常应答。

| 路径 | 作用 |
| --- | --- |
| `agent/PENNY.md` | agent 的指令：如何读消息、记账、结清、回复 |
| `agent/bin/penny.mjs` | agent 调用的命令行账本工具（`node bin/penny.mjs help`） |
| `agent/bin/ledger.mjs` | 账本工具和卡片渲染共用的 HTTP 客户端 |
| `agent/cards/` | 六种卡片、三种语言，先画成 SVG，再用 resvg 渲染为 PNG |
| `src/worker/ledger/routes.ts` | 账本 API 及其 bearer key 校验 |
| `src/worker/ledger/store.ts` | 提案、确认、版本、余额、统计 |
| `src/worker/ledger/money.ts` | 分摊与结清运算：纯函数，只用整数 |
| `src/worker/ledger/schema.ts` | 账本的数据表 |
| `src/worker/`（其余部分） | 起步模板的 Manyfold 连接流程、聊天和凭证加密 |
| `src/app/` | 起步模板的网页应用 |
| `tests/` | 单元测试（vitest），包括账本和金额运算 |

### 账本

- **只追加。** 修改或删除会为该条目新增一个版本，有人确认后才取代旧版本。
  `entry <room> <seq>` 可以看到所有版本。
- **先提案，后确认。** 条目一开始是 `pending`，未确认的条目不影响余额。
- **以群为范围。** 每一次查询都带群 id，也就是聊天平台的房间 id。
- **默认关闭。** 在设置 `PENNY_API_KEY` 这个 secret 之前，`/api/ledger/*` 一律返回 503，
  所以刚部署好的实例不会暴露一本谁都能访问的账本。

完整的路由列表在
[`src/worker/ledger/routes.ts`](src/worker/ledger/routes.ts) 的开头。

## 运行你自己的 Penny

### 1. 部署账本

每次推送到 `main`，都会由
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) 检查并部署。在你的 fork 里：

1. 用 `npx wrangler d1 create manyfold-penny-db` 创建数据库，把返回的 `database_id` 填进
   `wrangler.jsonc`。
2. 在 GitHub 仓库里添加 `CLOUDFLARE_API_TOKEN` secret 和 `CLOUDFLARE_ACCOUNT_ID` 变量。
   再把 `PRODUCTION_URL` 变量设为你的 Worker 地址，部署后的健康检查才会查对地方。
3. 设置账本密钥。请用足够长的随机值，agent 需要用同一个值。

   ```bash
   npx wrangler secret put PENNY_API_KEY
   ```

4. 建议：给网页应用加上密码，并把加密密钥放在数据库之外（见[安全说明](#安全说明)）。

   ```bash
   npx wrangler secret put ADMIN_PASSWORD
   ```

   ```bash
   npx wrangler secret put CONFIG_ENCRYPTION_KEY
   ```

schema 在运行时自动应用，没有迁移步骤。

### 2. 设置 agent

把 `agent/` 里的内容放进一个 Manyfold agent 的工作区，以 `PENNY.md` 作为它的指令。工作区
里还需要一个 `.penny/config.json`，这个文件被 git 忽略，需要单独上传：

```json
{ "apiBase": "https://<your-worker>.workers.dev", "apiKey": "<PENNY_API_KEY>" }
```

也可以改用环境变量 `PENNY_API_BASE` 和 `PENNY_API_KEY`。在工作区里安装卡片渲染唯一的依赖，
并下载一次字体（Noto Sans TC 和 SC）：

```bash
npm install && npm run setup
```

修改规则或工具之后，用 Manyfold CLI 重新上传：

```bash
mf files upload agent/PENNY.md PENNY.md --agent-id <id>
```

### 3. 给她发消息

Penny 要求每条消息都包在一段头信息里，说明消息来自哪个房间、谁在说话、群里有谁：

```
<penny-message>
room: !london:example
room_name: 倫敦四日
chat: group
from: @zack:example (Zack)
members: @zack:example (Zack); @mei:example (Mei); @ken:example (Ken); @ray:example (Ray)
time: 2026-11-08T19:42:00Z
---
@Penny 晚餐 Dishoom 120 我付，四個人分
</penny-message>
```

`room` 决定用哪一本账，所以把聊天平台接到 agent 的那一层必须负责填写它，并且不能让消息
正文覆盖它。

## 本地开发

```bash
npm install
cp .dev.vars.example .dev.vars   # 然后设置 PENNY_API_KEY 以及其他需要的项
npm run dev
```

一条命令同时跑起带 HMR 的网页应用，以及运行在 workerd 里、带本地 D1 数据库的 Worker。

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发服务器（应用 + worker + 本地 D1） |
| `npm run check` | 类型检查、构建、`wrangler deploy --dry-run` |
| `npm test` | 单元测试（vitest） |
| `npm run deploy` | 手动部署（通常由 GitHub Actions 完成） |
| `npm run smoke -- <url>` | 对一个部署做冒烟测试 |

想在没有账本的情况下调卡片，可以用内置的示例数据把六种卡片的每种语言都渲染一遍，PNG 会
输出到 `agent/out/demo/<lang>/`：

```bash
cd agent && npm install && npm run demo
```

想手动操作账本，把工具指向你的开发服务器即可：

```bash
PENNY_API_BASE=http://localhost:5173 PENNY_API_KEY=<key> node agent/bin/penny.mjs help
```

[`AGENTS.md`](AGENTS.md) 列出了修改这个代码库时需要保持的不变量。

## 安全说明

- **只有持有 `PENNY_API_KEY` 才能访问账本**，密钥以常数时间比较。调用它的是 agent 而不是
  浏览器，所以它跳过 Origin 检查和管理员密码。拿到这个密钥的人可以读写所有群的账本：只把它
  放在 agent 工作区的配置和 Worker secret 里，不要放在别处。
- **agent 被要求绝不泄露密钥**和 `.penny/config.json` 的内容，并且只从消息头读取房间 id，
  绝不从消息正文读取。
- **收款方式加密存储**（AES-GCM），只会展示给正要付钱给那个人的人。
- **网页应用默认是开放的。** 在你设置 `ADMIN_PASSWORD` 之前，任何知道 URL 的人都可以连接
  agents 并聊天。
- **网页应用用到的 agent token 以 AES-GCM 加密存在 D1 中**，密钥由 `CONFIG_ENCRYPTION_KEY`
  派生；未设置时，则使用首次使用时随机生成、并存在同一个数据库里的密钥。自动生成的密钥能
  防住局部泄露，但防不住整库导出；设置这个 secret 就没有这个问题。

## 许可证

[MIT](LICENSE)
