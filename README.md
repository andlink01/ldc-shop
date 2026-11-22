# LDC Shop (Workers + Docker)

[English](./README_EN.md)

---

基于 **Next.js 16** 和 **Shadcn UI** 构建的虚拟商品商店，提供 Cloudflare Workers 与 Docker 两种部署实现。

> [!IMPORTANT]
> 本仓库已移除根目录的 Vercel 版，仅保留 `_workers_next/` 和 `_docker/`。
> 

> 🚀 **推荐部署方式：Cloudflare Workers 或 Docker 自托管**
> 
> | 对比项 | Cloudflare Workers | Docker 自托管 |
> |--------|-------------------|--------------|
> | 代码目录 | `_workers_next/` | `_docker/` |
> | 数据库 | Cloudflare D1 | 本地 SQLite（better-sqlite3） |
> | 运行环境 | Workers + OpenNext | Node.js 容器 |
> | 定时任务 | Workers Cron Trigger | 容器内 node-cron |
> 
> 👉 **[Workers 完整功能与部署指南 → `_workers_next/README.md`](./_workers_next/README.md)**
> 
> 👉 **[Docker 部署指南 → `_docker/README.md`](./_docker/README.md)**

## 📢 登录状态公告（2026-03-04）

`Linux DO Connect` OAuth 登录已恢复正常，当前可正常完成授权并登录。

项目保留 **GitHub 登录** 作为备用方式（配置见 `_workers_next/README.md` 中的 GitHub OAuth 说明）。如有变化将在本公告更新。

## ✨ 特性概览

当前 **Workers 版本** 主要特性如下（完整列表见 [_workers_next/README.md](./_workers_next/README.md)）：

- **技术栈**: Next.js 16 (App Router)、Tailwind CSS、TypeScript；边缘部署为 **Cloudflare Workers + D1**。
- **Linux DO 集成**: OIDC 登录、EasyPay 支付；可选 GitHub 登录。
- **商城**: 搜索与分类、独立搜索页、心愿单与投票、公告栏、Markdown 描述、购买前提醒、**商品可见级别**（按信任等级）、热门与折扣、评分评论、库存/已售、共享卡密、限购、数量选择、自定义商店名称、**商品规格（多规格）** 等。
- **订单**: 支付回调验签、自动发货卡密、多卡密分发、默认收件邮箱、库存锁定、超时取消、订单中心（含规格标签）、待支付提醒、退款申请与自动退款、收款码。
- **管理后台**: 销售统计、库存预警、商品管理（含可见范围与规格）、分类管理、卡密管理、订单管理、订单清理、评价管理、数据导出/导入、公告、顾客管理、消息管理、退款设置、导航设置、店铺与主题（名称/描述/Logo/Favicon/主题色/字体/页脚/noindex）、签到设置、更新检查。
- **积分**: 每日签到（可配置开关与奖励）、积分抵扣、积分全额支付。
- **多语言与主题**: 中英切换、浅色/深色/跟随系统。
- **通知**: Resend 发货邮件、Telegram 与 **Bark** 新订单/退款/用户消息推送、站内收件箱与桌面通知、联系管理员、LDC 导航（含商店数目）。

## 🚀 部署指南

> 详细步骤与环境变量说明请查看：**[_workers_next/README.md](./_workers_next/README.md)**。

### ⭐ 推荐：Cloudflare Workers 部署

免费额度高、全球访问快、无冷启动。

👉 **[完整部署指南 → _workers_next/README.md](./_workers_next/README.md)**

### 备选：Docker 自托管

适用于 VPS/自有服务器，本地 SQLite，不依赖第三方云库。

👉 **[Docker 部署指南 → _docker/README.md](./_docker/README.md)**

## 💡 建议：绑定自定义域名

为获得最佳体验（即时支付状态更新），建议绑定自定义域名（如 `store.yourdomain.com`）。共享域名可能被支付平台或防火墙拦截，影响回调。

## ⚙️ 配置与本地开发

Workers 版所需的环境变量、OIDC/EPay 配置及本地开发步骤，请直接查看：**[_workers_next/README.md](./_workers_next/README.md)**。

根目录不再包含可运行的商城应用；构建和运行命令需要在对应版本目录执行。

## 📄 许可证
MIT
