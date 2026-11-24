# 卡密管理 API

这是**外部补货程序调用商城**的接口。本文按 Workers 和 Docker **1.5.15 / 结构版本 25** 的实际代码核对，两版的路径、鉴权、库存锁定、付款后采购和返回格式一致。Docker 需要从本仓库构建镜像才能获得这些改动。

将示例中的 `https://shop.example.com` 替换为你的商城地址。商品编码是商品链接 `/buy/<商品编码>` 或后台 `/admin/cards/<商品编码>` 中的值，例如 `invitationcode`；只允许字母、数字、下划线和连字符，长度 1–200。多规格商品每个规格有独立商品编码。

接口不需要 `next-action`、登录 Cookie、路由状态或 D1 数据库 UUID。它只查询商品和库存、添加卡密，不支持读取卡密原文、删除卡密或管理密钥。密钥管理在后台操作。

## 对接前需要交换什么资料

**店主提供商城地址、商品编码和补货密钥；对方准备卡密，调用商城接口添加到库存。** 接口由商城提供，对方实现调用程序即可。

| 店主给补货程序开发者的资料 | 从哪里取得或如何确定 |
|---|---|
| 商城地址 | 已部署商城的完整地址，例如 `https://shop.example.com`，不是 GitHub 仓库或后台页面地址 |
| 商品编码及对应商品/规格 | 后台 `/admin/cards/<商品编码>` 或商品链接 `/buy/<商品编码>` 中的编码；多个商品、规格分别列出 |
| 补货密钥 | 两版均可在后台“补货接口”创建并查看/复制，也可使用已配置的 `INVENTORY_API_KEY` |
| 密钥权限、商品范围和到期时间 | 添加卡密需要添加权限；需要查询商品或库存时再授予查询权限。选择允许补货的商品，并告知密钥是否会到期 |
| 卡密有效期要求 | 商城入库后的有效期；永久有效可不传有效期参数，22 小时 30 分钟填写 `expiresInSeconds: 81000` |

对方提供实际卡密内容，并按下文实现批量提交、返回结果判断和同批次重试。卡密有效期与密钥到期时间是两项不同设置。这里用的是**店主创建的补货密钥**，不是 [付款后采购](supplier-api.md) 使用的供应商 Token；对方不需要商城管理员账号、支付密钥或数据库访问权限。

可以复制以下资料模板，填写后交给对接开发者：

```text
对接方式：外部程序给商城库存补卡
接口文档：https://github.com/andlink01/ldc-shop/blob/main/docs/inventory-api.md
商城地址：https://shop.example.com（替换为实际地址）
商品编码：invitationcode（替换为实际编码，每个规格单独列出）
商品/规格说明：填写该编码对应的商品及规格
补货密钥：填写店主创建的密钥
权限与范围：添加卡密；填写允许操作的商品，需查询时增加查询权限
密钥到期时间：填写到期时间或永久有效
卡密有效期：填写永久有效，或导入后多少秒有效
提交地址：POST <商城地址>/api/v1/products/<商品编码>/cards
重试规则：每批独立 Idempotency-Key；失败重试保持原密钥、原编号和原正文
```

商城地址、商品编码、密钥是运行程序所需的配置。每批 `Idempotency-Key` 由调用程序生成，不需要店主提前逐批提供；完整请求、有效期参数和响应规则见下文。

## 配置密钥

两版均推荐在后台“补货接口”创建密钥，选择可操作的商品、查询或补卡权限及到期时间，无需配置 `INVENTORY_API_KEY`。创建后在列表点击“查看”或“复制”即可再次取出密钥；浏览器禁止自动复制时，弹窗内可选中密钥手动复制。

忘记旧版密钥时可点击“重置”，确认后生成新值，原记录的名称、商品范围、权限、期限、启停状态和请求记录保留，旧值立即失效。重置后将新值填写到补货程序。旧版只保存哈希，不能还原原值；新建或重置的密钥保存哈希和加密原值，不保存明文。查看与重置均要求管理员登录。

两版均可在列表点击“删除”，确认后移除该密钥，之后的请求无法再用它鉴权。删除不可恢复；已导入的卡密、导入回执与历史请求记录保留，历史记录不再关联原密钥名称，显示为“部署密钥或已删除密钥”。暂时不用请选择“停用”，停用后可以再次启用。已通过鉴权的执行中请求可能继续完成。

创建时至少选择一种权限，最多指定 50 个商品，留空到期时间表示永久有效。“全部商品”包含以后新建的商品；“指定商品”只允许选中的商品。重置不改变原权限、范围、到期时间和启停状态，也不会让已过期的密钥重新有效。

两版均继续支持环境变量密钥：

生成独立随机密钥，例如在本机执行：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

- Cloudflare：在当前 Worker 的 **Settings → Variables and Secrets** 添加 Secret，名称为 `INVENTORY_API_KEY`，值为生成的密钥。保存并重新部署。
- Docker：在 Compose 的 `environment` 中设置 `INVENTORY_API_KEY`，重新创建容器。无需更换数据库或卷。

环境变量密钥必须为 32–512 个非空白字符，允许查询全店商品及为任意商品补卡。`ldc_inv_` 前缀保留给后台生成的密钥，不要用它作为环境密钥的前缀。所有接口使用 `Authorization: Bearer <密钥>`，不能将密钥放进 URL 或正文。后台创建的密钥与环境密钥独立生效；删除后台密钥不会撤销环境密钥，环境密钥需在部署环境修改或删除。

后台密钥按指定范围和权限鉴权，停用或过期返回 `401 key_disabled_or_expired`；旧哈希密钥升级后继续有效。环境密钥未配置或格式无效，且请求未使用 `ldc_inv_` 后台密钥时，返回 `503 api_not_configured`。请求使用不存在的后台密钥返回 `401 unauthorized`；环境密钥已配置但请求缺少或使用错误密钥也返回该错误。

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/products` | 查询商品编码、名称、价格、规格、上架状态和库存 |
| GET | `/api/v1/products/<商品编码>/cards` | 查询单个商品及实时库存，不返回卡密内容 |
| POST | `/api/v1/products/<商品编码>/cards` | 批量导入卡密 |

两个 GET 需要“查询商品和库存”权限，POST 需要“添加卡密”权限。仅有添加权限的程序仍可向已知商品编码补卡，不能执行 GET。列表只返回密钥允许访问的商品；直接查询或补卡到范围外的商品返回 `403 product_forbidden`，缺少操作权限返回 `403 permission_denied`。

### 查询商品列表

`GET /api/v1/products` 的可选查询参数：

| 参数 | 规则 |
|---|---|
| `limit` | 整数 1–200，默认 50 |
| `cursor` | 上一页返回的 `nextCursor`，第一页省略；保持相同搜索条件 |
| `q` | 商品名称模糊搜索，去掉首尾空白后最多 100 字符；`%` 和 `_` 按 LIKE 通配符处理 |

商品按编码升序返回，包含下架商品，不按前台展示或用户等级过滤。`nextCursor: null` 表示没有下一页。示例 HTTP 200（两版相同）：

```json
{
  "success": true,
  "data": {
    "products": [
      {
        "id": "invitationcode",
        "name": "示例商品",
        "price": "3.00",
        "isActive": true,
        "isShared": false,
        "variantGroupId": null,
        "variantLabel": null,
        "fulfillmentMode": "stock",
        "stock": { "unused": 10, "available": 8, "locked": 2 }
      }
    ],
    "nextCursor": null
  }
}
```

### 查询单个商品库存

`GET /api/v1/products/invitationcode/cards` 无需正文，HTTP 200 的 `data` 直接是商品对象，没有 `products` 或 `nextCursor`：

```json
{
  "success": true,
  "data": {
    "id": "invitationcode",
    "name": "示例商品",
    "price": "3.00",
    "isActive": true,
    "isShared": false,
    "variantGroupId": null,
    "variantLabel": null,
    "fulfillmentMode": "stock",
    "stock": { "unused": 10, "available": 8, "locked": 2 }
  }
}
```

`price` 是字符串，`isActive`、`isShared` 是布尔值，规格字段可为 `null` 或空字符串，库存字段是非负整数。两版均包含 `fulfillmentMode`。所有 JSON 响应带 `Cache-Control: no-store`、`Vary: Authorization`。

`stock.unused` 是未使用且未过期的卡密总数，`locked` 是其中被订单锁定的数量，`available = unused - locked`。锁定包含五分钟付款锁，以及已付款待发货订单的预留卡密；已付款预留不会因超过五分钟而转为可用。共享商品也返回真实卡密条数，不返回“无限库存”数值；前台按共享商品规则展示。

`fulfillmentMode` 为 `on_demand` 时，表示非共享商品的付款后采购已启用且配置了地址，允许零预存卡密下单；停用或空地址时返回 `stock`。它不表示商品已上架或供应商当前一定可用，库存数仍表示实际卡密数量。第三方取卡配置见 [付款后采购接口规范](supplier-api.md)，此处的补货密钥与商城调用供应商时使用的 Token 分别配置。

## 导入与有效期

先建立 `cards.json`（UTF-8）：

```json
{
  "cards": ["sddssssss"],
  "expiresInSeconds": 81000
}
```

`81000` 秒 = **22 小时 30 分钟**。从首次成功导入时计时，与后台填写小时、分钟的规则一致：到期后卡密不再计入可用库存，两版均保留到期记录供管理员处理。它不会改变外部服务本身的账号或兑换码有效期。

Windows PowerShell 示例（将 `https://shop.example.com` 替换为实际商城域名，并替换密钥）：

```powershell
curl.exe --request POST "https://shop.example.com/api/v1/products/invitationcode/cards" --header "Authorization: Bearer 替换为你的密钥" --header "Content-Type: application/json" --header "Idempotency-Key: invitationcode-batch-001" --data-binary "@cards.json"
```

Linux/macOS 使用同一命令，将 `curl.exe` 改为 `curl`。

```powershell
curl.exe "https://shop.example.com/api/v1/products?limit=50" --header "Authorization: Bearer 替换为你的密钥"
curl.exe "https://shop.example.com/api/v1/products/invitationcode/cards" --header "Authorization: Bearer 替换为你的密钥"
```

POST 必须发送 UTF-8 JSON 对象，`Content-Type: application/json`（可带 `charset=utf-8`）。每次允许 1–500 条非空字符串，去掉首尾空白后每条最多 4096 字符，不含 NUL；保留内部换行。请求体最多 256 KiB，因此 500 条很长的卡密需要分批。可直接导入已下架商品的库存。

有效期二选一：

- `expiresInSeconds`：正整数，最多 31,536,000 秒（365 天）。
- `expiresAt`：带时区且包含秒的 ISO 时间，例如 `"2026-12-01T22:30:00+08:00"`，首次导入时必须晚于当前时间。格式为 `YYYY-MM-DDTHH:mm:ss[.SSS]Z` 或带 `±HH:mm` 时区，小数秒可为 1–3 位；不接受 Unix 时间戳或无时区时间。

两项都省略或为 `null` 时不过期。同一批次的卡密使用相同有效期。

## 重试与返回

每一批卡密使用一个独立的 `Idempotency-Key`；网络失败、超时或 5xx 后重试保持同一密钥、同一 Key 和相同正文，新批次更换 Key。Key 允许字母、数字及 `._:-`，长度 1–128。

去重范围按实际鉴权方式区分：

| 鉴权方式 | `Idempotency-Key` 的范围 |
|---|---|
| 后台密钥（两版） | 同一密钥记录内跨商品共用；不同密钥记录分别去重 |
| 环境密钥（两版） | 整个环境密钥入口共用，与后台密钥隔离；更换环境密钥值仍沿用已有回执 |

原地重置后台密钥保留记录 ID，重试仍能命中旧回执。删除再创建或改用另一条密钥会进入新的去重范围，**不要用新密钥重放已经成功的批次**，否则可能重复入库。

首次成功返回 HTTP 201：

```json
{
  "success": true,
  "data": {
    "productId": "invitationcode",
    "productName": "商品名称",
    "added": 1,
    "idempotencyKey": "invitationcode-batch-001",
    "replayed": false
  }
}
```

相同 Key 和相同内容再次请求返回 HTTP 200、`replayed: true`，不会再次插入，也不会延长相对有效期。Key 相同但商品或内容不同返回 HTTP 409 `idempotency_conflict`。导入记录、卡密和库存数量在同一数据库事务提交；发生错误时整批回滚。

正文指纹按商品编码、去除首尾空白后的卡密数组（包括顺序）和有效期参数计算；相同正文仅改变 JSON 排版不产生冲突。将相对有效期改为绝对有效期、改变卡密顺序或商品编码则产生冲突。已成功导入的批次即使到期后重试，仍返回原回执。

重放响应中的 `added` 是首次导入条数，并非本次新增条数；程序统计实际补入时须同时判断 `replayed`。后台“实际补入”对重放记为 0。两版导入成功后自动尝试恢复该商品已付款待发货订单，恢复失败不改变已经提交的导入结果。拥有完整有效预留的订单可直接使用自己的卡密，公共库存继续按付款顺序分配。

不传 Key 时服务器为本次请求生成一个 Key，但网络失败后无法据此安全重试。建议脚本始终显式传入 Key。商城当前允许重复卡密文本；不同 Key 可以导入相同文本，去重重试依靠 Key，而不是卡密文本。

错误返回格式为 `{"success":false,"error":"错误编码"}`，不包含卡密或数据库原始错误：

| HTTP | `error` | 处理方式 |
|---|---|---|
| 400 | `invalid_product_id`、`invalid_pagination` | 检查商品编码、分页或搜索参数 |
| 400 | `invalid_json`、`invalid_body` | 检查 UTF-8 编码及 JSON 对象格式 |
| 400 | `cards_must_contain_1_to_500_items`、`invalid_card` | 检查卡密数组、条数、长度和空白字符 |
| 400 | `invalid_expiry`、`invalid_idempotency_key` | 检查有效期及批次编号 |
| 401 | `unauthorized` | 检查 Bearer 密钥，已删除或重置的旧值无效 |
| 401 | `key_disabled_or_expired` | 后台密钥已停用或到期 |
| 403 | `permission_denied`、`product_forbidden` | 检查操作权限及商品范围 |
| 403 | `invalid_key_scope` | 密钥范围记录无效，需管理员处理 |
| 404 | `product_not_found` | 检查商品是否存在 |
| 409 | `idempotency_conflict` | 恢复原请求正文；不要换 Key 强行重试同一批次 |
| 413 | `body_too_large` | 拆成更小批次，每批独立 Key |
| 415 | `json_required` | 使用 `application/json` |
| 500 | `import_failed`、`internal_error` | 保持原密钥、Key 和正文重试，持续失败检查运行日志 |
| 503 | `api_not_configured` | 配置有效环境密钥，或使用后台密钥 |

请求通过鉴权后，两版尽力记录结果，包括权限错误、参数错误和去重重试；停用或过期的已识别密钥也记录失败。未知密钥或环境鉴权失败没有可关联的密钥记录，不保证出现在后台。商城没有为该接口实现应用层限流、`Retry-After` 或自动重试，调用程序应控制并发和重试间隔。

## 数据与部署

首次请求沿用商城现有初始化流程。两版结构版本为 25，Docker 从旧结构 22 自动升级，保留已有数据及 `inventory_imports` 回执。全量备份包含密钥密文、导入回执、采购编号、发货记录与持久退款请求；Workers 在同一个 D1 事务批次读取全部 23 张表，Docker 在一个 SQLite 读取事务中获取一致快照，防止备份期间发货造成订单与卡密状态不一致。删除密钥不删除历史回执。

两版密钥加密使用当前有效的认证 Secret，依次读取 `AUTH_SECRET`、`NEXTAUTH_SECRET`、`OAUTH_CLIENT_SECRET`，没有新增必须配置的环境变量。恢复备份时应沿用原值，并单独备份此 Secret，数据库导出不会包含它。更换认证 Secret 后，原补货密钥仍可通过哈希鉴权，但旧密文无法查看；可在后台原地重置并更新补货程序。

后续业务同步检查在仓库根目录执行：

```sh
node scripts/sync-variants.mjs --check
node scripts/compare-variants.mjs --summary
```

维护者按项目约定运行 `node scripts/sync-variants.mjs --write` 同步共享业务，再运行 `--check` 和两版回归；该操作不是 API 配置步骤。脚本保留各平台数据库驱动和部署文件，Docker 适配及真实镜像另行验证。

两版测试使用本机 Node.js 22.16 或更高版本，数据库测试全部使用隔离的临时 SQLite，不访问生产 D1：`npm run test:auth`、`npm run test:inventory`、`npm run test:db`。
