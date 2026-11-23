# 卡密管理 API

Workers 和 Docker 提供相同的固定接口。商品编码是商品链接 `/buy/<商品编码>` 或后台 `/admin/cards/<商品编码>` 中的值，例如 `invitationcode`。`next-action` 是 Next.js 构建生成的操作标识，可能在更新后变化；这些接口不需要它，也不需要登录 Cookie、路由状态或 D1 数据库 UUID。

## 配置密钥

Workers 推荐在后台“补货接口”创建密钥，选择可操作的商品、查询或补卡权限及到期时间，无需配置 `INVENTORY_API_KEY`。创建后在列表点击“查看”或“复制”即可再次取出密钥；浏览器禁止自动复制时，弹窗内可选中密钥手动复制。

忘记旧版密钥时可点击“重置”，确认后生成新值，原记录的名称、商品范围、权限、期限、启停状态和请求记录保留，旧值立即失效。重置后将新值填写到补货程序。旧版只保存哈希，不能还原原值；新建或重置的密钥保存哈希和加密原值，不保存明文。查看与重置均要求管理员登录。

Docker 1.4.3 尚无后台密钥管理；两版均继续支持环境变量密钥：

生成独立随机密钥，例如在本机执行：

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

- Cloudflare：在当前 Worker 的 **Settings → Variables and Secrets** 添加 Secret，名称为 `INVENTORY_API_KEY`，值为生成的密钥。保存并重新部署。
- Docker：在 Compose 的 `environment` 中设置 `INVENTORY_API_KEY`，重新创建容器。无需更换数据库或卷。

环境变量密钥必须为 32–512 个非空白字符，允许查询全店商品及为任意商品补卡。所有接口使用 `Authorization: Bearer <密钥>`。Workers 后台密钥按指定范围和权限鉴权，停用或过期后无法使用；旧哈希密钥升级后继续有效。环境变量密钥未配置且请求未使用后台密钥时，API 返回 `503 api_not_configured`；配置后缺少或错误的密钥返回 `401 unauthorized`。

## 接口

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/products` | 查询商品编码、名称、价格、规格、上架状态和库存 |
| GET | `/api/v1/products/<商品编码>/cards` | 查询单个商品及实时库存，不返回卡密内容 |
| POST | `/api/v1/products/<商品编码>/cards` | 批量导入卡密 |

商品列表支持 `limit`（1–200，默认 50）、`cursor`（上一页的 `nextCursor`）和 `q`（商品名称搜索，最多 100 字符）。`nextCursor: null` 表示没有下一页。多规格商品每个规格有各自商品编码，补卡时填写对应规格的编码。

`stock` 中的 `unused` 为未使用且未过期的卡密数；`locked` 为有效支付锁定数量；`available` 为当前可分配数量。共享商品可通过 `isShared` 识别，前台仍按共享商品规则显示无限库存。

Workers 另返回 `fulfillmentMode`，值为 `stock` 或 `on_demand`。付款后采购商品可在没有预存卡密时下单，接口中的库存数仍表示实际卡密数量。第三方取卡配置见 [付款后采购接口规范](supplier-api.md)，此处的补货密钥用于外部程序调用商城，与商城调用供应商时使用的 Token 分别配置。

## 导入与有效期

先建立 `cards.json`（UTF-8）：

```json
{
  "cards": ["sddssssss"],
  "expiresInSeconds": 81000
}
```

`81000` 秒 = **22 小时 30 分钟**。从首次成功导入时计时，与后台填写小时、分钟的规则一致：到期后卡密不再计入可用库存。Workers 保留到期记录供管理员处理，Docker 1.4.3 按原清理机制处理。它不会改变外部服务本身的账号或兑换码有效期。

Windows PowerShell 示例（将 `https://shop.example.com` 替换为实际商城域名，并替换密钥）：

```powershell
curl.exe --request POST "https://shop.example.com/api/v1/products/invitationcode/cards" --header "Authorization: Bearer 替换为你的密钥" --header "Content-Type: application/json" --header "Idempotency-Key: invitationcode-batch-001" --data-binary "@cards.json"
```

Linux/macOS 使用同一命令，将 `curl.exe` 改为 `curl`。

```powershell
curl.exe "https://shop.example.com/api/v1/products?limit=50" --header "Authorization: Bearer 替换为你的密钥"
curl.exe "https://shop.example.com/api/v1/products/invitationcode/cards" --header "Authorization: Bearer 替换为你的密钥"
```

每次允许 1–500 条非空字符串，每条最多 4096 字符，请求体最多 256 KiB。会去掉卡密首尾空白；保留内部换行。可直接导入已下架商品的库存。

有效期二选一：

- `expiresInSeconds`：正整数，最多 31,536,000 秒（365 天）。
- `expiresAt`：带时区的 ISO 时间，例如 `"2026-12-01T22:30:00+08:00"`，首次导入时必须晚于当前时间。

两项都省略或为 `null` 时不过期。同一批次的卡密使用相同有效期。

## 重试与返回

每一批卡密使用一个独立的 `Idempotency-Key`；失败重试保持同一个 Key 和相同正文，新批次更换 Key。Key 允许字母、数字及 `._:-`，长度 1–128，全店共享同一命名空间。

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

不传 Key 时服务器为本次请求生成一个 Key，但网络失败后无法据此安全重试。建议脚本始终显式传入 Key。商城当前允许重复卡密文本；不同 Key 可以导入相同文本，去重重试依靠 Key，而不是卡密文本。

错误返回格式为 `{"success":false,"error":"错误编码"}`。常见状态：400 参数/有效期错误，401 鉴权失败，404 商品不存在，409 重试内容冲突，413 请求过大，415 非 JSON 请求，500 导入失败，503 未配置密钥。错误响应不包含卡密或数据库原始错误。

## 数据与部署

首次请求沿用商城现有初始化流程。Docker 1.4.3 的结构版本为 22，包含 `inventory_imports`；Workers 1.5.3 自动升级到 25，为 `inventory_api_keys` 增加可为空的 `token_encrypted` 字段。商品 ID、已有卡密、订单、密钥哈希、D1 绑定及 Docker 数据卷保持原值。全量备份包含导入回执，恢复后保留重试保护；Workers 备份同时包含密钥密文、采购编号和发货记录。

Workers 密钥加密使用当前有效的认证 Secret，依次读取 `AUTH_SECRET`、`NEXTAUTH_SECRET`、`OAUTH_CLIENT_SECRET`，没有新增必须配置的环境变量。恢复备份时应沿用原值，并单独备份此 Secret，数据库导出不会包含它。更换认证 Secret 后，原补货密钥仍可通过哈希鉴权，但旧密文无法查看；可在后台原地重置并更新补货程序。

后续业务同步检查在仓库根目录执行：

```sh
node scripts/sync-variants.mjs --check
node scripts/compare-variants.mjs --summary
```

需要将 Workers 的业务修改同步到 Docker 时执行 `node scripts/sync-variants.mjs --write`，再验证两版。脚本保留各平台数据库驱动和部署文件。

两版测试使用本机 Node.js 22.16 或更高版本，数据库测试全部使用隔离的临时 SQLite，不访问生产 D1：`npm run test:auth`、`npm run test:inventory`、`npm run test:db`。
