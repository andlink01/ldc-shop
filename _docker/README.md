# LDC Shop (Docker Edition)

基于 **Next.js 16**、**SQLite** 和 **Shadcn UI** 构建的虚拟商品商店 Docker 版本。

本版本基于 `_workers_next`（Cloudflare Workers 版）改造，将数据库从 Cloudflare D1 替换为本地 SQLite（`better-sqlite3`），适用于 VPS / 自托管部署。

当前版本为 **1.5.24 / 数据库结构 25**。支持商品管理、订单、卡密、退款、积分和通知等功能。部署使用独立 SQLite 数据卷，更新时请保留数据库和现有环境配置。

使用这些功能需要从本仓库自行构建镜像：

```bash
git clone https://github.com/andlink01/ldc-shop.git
cd ldc-shop/_docker
# 先编辑 docker-compose.yml 中的 URL、登录和支付配置；API 密钥为可选配置
docker compose up -d --build
```

## 技术架构

- **核心框架**: Next.js 16 (App Router) + TypeScript
- **数据库**: SQLite（better-sqlite3），数据文件持久化到 Docker volume
- **ORM**: Drizzle ORM
- **认证**: NextAuth（Linux DO Connect + GitHub OAuth）
- **支付**: EPay
- **UI**: Tailwind CSS + Shadcn UI + Framer Motion

---

## 从本仓库部署

### 方法 A：一键脚本（交互式）

```bash
git clone https://github.com/andlink01/ldc-shop.git
cd ldc-shop/_docker
chmod +x setup.sh
./setup.sh
```

脚本会引导你输入必要的配置项，自动生成 `.env` 和 `docker-compose.yml`，并构建启动容器。

### 方法 B：手动构建

```bash
git clone https://github.com/andlink01/ldc-shop.git
cd ldc-shop/_docker
```

编辑 `docker-compose.yml` 中的站点、认证、支付和管理员配置，保留 `./data:/app/data` 数据卷，然后：

```bash
mkdir -p data && chmod 777 data
docker compose up -d --build
```

### 更新已有部署

在保留数据库目录和已有配置的情况下获取本仓库更新并重新构建：

```bash
git pull --ff-only origin main
docker compose up -d --build
```

旧结构 22 在首次应用请求时自动升级到 25，保留商品、卡密、订单、积分及导入回执；不再在启动时运行交互式 `drizzle-kit push`。保持原认证 Secret，后台密钥密文才能在重建后继续查看。仓库保留的 `pull-setup.sh` 拉取上游镜像，不能用于获取本次定制更新。

接口配置见 [卡密管理 API](../docs/inventory-api.md) 与 [付款后采购接口](../docs/supplier-api.md)。

---

## 反向代理配置

容器监听 `3000` 端口，生产环境建议用 Nginx / Caddy 反向代理并配置 HTTPS。

**Nginx 示例：**

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
    }
}
```

**Caddy 示例（自动 HTTPS）：**

```
your-domain.com {
    reverse_proxy localhost:3000
}
```

---

## 环境变量说明

| 变量 | 必填 | 说明 |
|------|------|------|
| `APP_URL` | 是 | 站点外部访问地址，如 `https://your-domain.com` |
| `NEXT_PUBLIC_APP_URL` | 是 | 同 `APP_URL`，值保持一致 |
| `AUTH_TRUST_HOST` | 是 | 设为 `true`，信任反代传递的 Host 头 |
| `AUTH_SECRET` | 是 | 随机字符串，用于加密 session |
| `OAUTH_CLIENT_ID` | 是 | Linux DO Connect OAuth Client ID |
| `OAUTH_CLIENT_SECRET` | 是 | Linux DO Connect OAuth Client Secret |
| `MERCHANT_ID` | 是 | EPay 商户 ID |
| `MERCHANT_KEY` | 是 | EPay 商户密钥 |
| `PAY_URL` | 否 | 支付接口地址，默认 Linux DO Credit |
| `ADMIN_USERS` | 是 | 管理员用户名，多个用逗号分隔 |
| `DATABASE_PATH` | 否 | SQLite 路径，默认 `/app/data/ldc-shop.sqlite` |
| `GITHUB_ID` | 否 | GitHub OAuth Client ID |
| `GITHUB_SECRET` | 否 | GitHub OAuth Client Secret |
| `INVENTORY_API_KEY` | 否 | 独立的环境补货密钥；也可直接在后台创建商品范围及权限不同的密钥 |
| `CRON_CLEANUP_TOKEN` | 否 | 定时任务鉴权，未配置时使用 `OAUTH_CLIENT_SECRET`；仅 GitHub 登录时需单独配置 |

> Telegram 通知、Bark 推送、邮件通知等可选功能在管理后台中配置，无需设置环境变量。

---

## GitHub OAuth App 创建方法

如需启用 GitHub 登录（作为 Linux DO Connect 的备用登录方式），按以下步骤创建 OAuth App：

1. 访问 [GitHub Developer Settings](https://github.com/settings/developers)
2. 点击 **New OAuth App**
3. 填写信息：
   - **Application name**: `LDC Shop`（任意名称）
   - **Homepage URL**: `https://your-domain.com`（你的站点地址）
   - **Authorization callback URL**: `https://your-domain.com/api/auth/callback/github`
4. 点击 **Register application**
5. 记录 **Client ID**，点击 **Generate a new client secret** 获取 **Client Secret**
6. 将两个值填入 `.env` 文件的 `GITHUB_ID` 和 `GITHUB_SECRET`
7. 重启容器生效：`docker compose down && docker compose up -d`

---

## 数据持久化与备份

SQLite 数据库文件存储在 `./data/ldc-shop.sqlite`，通过 Docker volume 挂载持久化。运行中的备份可在后台“数据管理”下载全量 SQL，所有表在同一个读取快照中导出。

备份整个 SQLite 目录时，先停止应用，连同 WAL 等文件一起复制：

```bash
docker compose stop app
cp -a ./data ./data-backup-$(date +%Y%m%d-%H%M%S)
docker compose start app
```

恢复目录备份时同样先停止应用；先保存现有目录，再将备份作为整个数据目录恢复，避免旧 WAL 混入：

```bash
docker compose stop app
mv ./data ./data-before-restore-$(date +%Y%m%d-%H%M%S)
cp -a ./data-backup-20261124-120000 ./data
docker compose start app
```

将示例备份目录替换为实际路径。认证 Secret 需另行保留，SQL 导出和 SQLite 数据目录不包含部署环境变量。

## 定时任务

容器内置 cron 定时任务（每分钟执行），自动处理：
- 超时未支付订单的清理
- 过期卡密预留的释放
- 已付款订单自动补发与付款后采购恢复
- 持久通知事件重试与到期提醒

## 修改环境变量后生效方式

```bash
# 修改 .env 后需要重建容器（不是 docker restart）
docker compose down && docker compose up -d

# 如果修改了源码，需要重新构建
docker compose up -d --build
```
