# Stronghold-Protocol Server Manager · 卫戍协议服务器管理后台

用于管理 **[《卫戍协议：盟约》Stronghold Protocol: Alliance](https://github.com/sganggs/Stronghold-Protocol)** 自建服务器的独立管理后台：监控主机与对局、管理服务启停、按需扩展插件。基于 **Node.js 24 LTS + Vue 3 + Vite**，生产环境由 Node 直接提供网页与 API，无 CDN。

![version](https://img.shields.io/badge/version-2.0.0-2ea44f)
![node](https://img.shields.io/badge/node-22%20%7C%2024-339933)

## 声明

> [!IMPORTANT]
> - 本项目是**独立的第三方工具**，用于管理 **Stronghold-Protocol（[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)）** 自建服务器；与该项目作者、以及鹰角网络（Hypergryph）/ Yostar 均**无隶属或授权关系**。
> - 它**不包含、不修改、不再分发**游戏的代码与素材：只通过游戏原有的 HTTP 健康接口读取数据，并按你在配置里显式给出的固定命令启停服务。
> - 游戏相关的名称、角色与素材版权归原权利人所有；请自行遵守游戏项目的许可与[声明](https://github.com/sganggs/Stronghold-Protocol#声明)。
> - 本项目按「现状」提供，**不提供任何担保**，使用风险自负。

## 目录

- [简介](#简介) · [功能一览](#功能一览)
- [快速开始](#快速开始)：[一键部署（推荐）](#方式一linux-一键部署systemd推荐) · [从源码运行](#方式二从源码运行) · [系统要求](#系统要求) · [端口与环境变量](#端口与环境变量)
- [配置](#配置) · [服务管理](#服务管理) · [反向代理与-https](#反向代理与-https) · [插件](#插件)
- [文档](#文档) · [开发与测试](#开发与测试) · [项目结构](#项目结构) · [链接](#链接)

## 简介

游戏服务本身是一个常驻 Node.js 程序，战斗在各玩家浏览器里模拟，服务器只管经济、回合与房间。本后台在**同一台机器**上与游戏并列运行，面向单个管理员，做三件事：

- **监控**：读取游戏的 `GET /healthz`（在线状态、版本、房间、进行中对局、AI、观战、会话与连接），并采集所在主机自身的性能。
- **管理**：只执行每个服务在配置里写的固定命令（本地项目进程，或 systemd 单元），不解析网页输入、不经过 shell。
- **扩展**：插件系统，每个插件可建多个实例、绑定不同服务、各自设置与启停。

后台**不引用、不导入、不修改**游戏文件，可单独部署、单独升级。

## 功能一览

- 多节点在线状态、响应耗时、版本、运行时长、房间、进行中对局、AI、观战、会话与连接数。
- 主机指标：CPU 总/每核、内存、Swap、负载、磁盘、网卡收发速率/累计/错误、运行时长、后台进程 RSS；CPU/内存/磁盘达到 90% 页面提示。
- 服务管理：本地项目 / systemd / 只读网络地址三种接入；按状态智能启停；实时日志（项目日志或 journalctl）。
- 服务**脱手运行**：后台启动的本地服务独立于后台进程，后台退出或重启都不会停止它们。
- 安全：密码登录、8 小时 HttpOnly Cookie、失败限流、跨域写入来源校验、scrypt 带盐哈希。
- 插件：清单声明设置字段与操作按钮；多实例、绑定服务；内置「资源阈值检查」「卫戍协议 · 定时更新」示例。

> 关于数据口径的边界：**真人席位 ≠ 严格在线人数**（游戏会为断线玩家保留席位，WebSocket 含大厅/观战），接口也没有去重在线数、名单或房间明细——本项目不伪造数据。

## 快速开始

### 方式一：Linux 一键部署（systemd，推荐）

```bash
git clone git@github.com:Summerburier/Stronghold-Protocol-Server-Manager.git
cd Stronghold-Protocol-Server-Manager
npm ci && npm run build
sudo bash deploy/install-dashboard.sh --user "$USER" --no-build --host 0.0.0.0
```

脚本会创建系统用户、准备 `data/`、`.env`（自动生成随机初始密码）与 `config.json`，写入 `/etc/systemd/system/shp-dashboard.service` 后 `daemon-reload` + `enable --now`，并打印访问地址、初始密码和日志命令。参数：`--name` / `--user` / `--dir` / `--port` / `--host` / `--node`（nvm 等 sudo 下找不到 node 时用）/ `--no-build`；`--help` 查看。

手动部署参考模板 `deploy/shp-dashboard.service`：按实际 Node 路径改 `ExecStart` 后 `systemctl daemon-reload && systemctl enable --now shp-dashboard`。

### 方式二：从源码运行

```bash
cp .env.example .env
cp config.example.json config.json
npm ci
npm run build
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 填入 .env 的 ADMIN_PASSWORD
npm start
```

访问 `http://127.0.0.1:7999`，用 `.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录（保留占位密码会先进入首次初始化页）。前端开发：`npm run dev`（同时启动后端与 Vite，访问 `http://127.0.0.1:5173`）；改 `web/` 后需 `npm run build` 并重启。

### 系统要求

| 项目 | 要求 |
|---|---|
| 后台所在主机 | Windows / macOS / Linux，Node.js 22 或 24（LTS）；与游戏同机部署即可监控该主机的性能 |
| 玩家 | 无需访问本后台；后台只给管理员用 |
| 网络 | 后台默认只监听本机 `127.0.0.1:7999`；对外访问用反向代理 + HTTPS 或 SSH 隧道 |

### 端口与环境变量

默认监听 **TCP 7999**（可被 `.env` / `--port` 覆盖）。

| 变量 | 默认 | 说明 |
|---|---|---|
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / — | 初始账户；密码 ≥8 位，占位值触发首次初始化（兼容旧 `ADMIN_TOKEN`） |
| `HOST` / `PORT` | `127.0.0.1` / `7999` | 监听地址与端口 |
| `CONFIG_FILE` | `config.json` | 配置路径（相对项目目录） |
| `DATA_DIR` | `data` | 历史、会话、插件状态等运行数据目录 |
| `PLUGINS_DIR` | `plugins` | 插件目录 |
| `COOKIE_SECURE` | `false` | 使用 HTTPS 时设为 `true` |

健康检查：`GET /healthz`（只表示后台自身存活，不代表游戏在线）。

## 配置

`config.json`（也可在“服务”页编辑后保存）：

```json
{
  "pollIntervalSeconds": 15,
  "retentionHours": 24,
  "host": { "pollIntervalSeconds": 5, "diskPaths": ["/"], "networkInterfaces": ["eth0"] },
  "servers": [
    { "id": "game", "name": "卫戍协议", "source": "../Stronghold-Protocol" },
    { "id": "web", "name": "Web", "source": "nginx.service", "sudo": true }
  ],
  "pluginsDirectory": "plugins"
}
```

- `source` 为**目录**（读取 `package.json` 或游戏官方 `scripts/launch.mjs` 启动）或 **`.service`**（systemd 单元）。
- `url` 可选，仅用于读取游戏健康数据；**可省略**——project 按 `env.PORT`、systemd 按单元的 `Environment` / `ExecStart` 自动推导 `http://127.0.0.1:<端口>`，仍可手动覆盖。
- `projectOptions` 可配 `entry` / `args` / `env`；systemd 的 `sudo: true` 使用非交互 sudo。
- 采样范围：`pollIntervalSeconds` 5–3600、`retentionHours` 1–168、主机 `host.pollIntervalSeconds` 2–60。网卡建议按实际名称指定（`ip -br link`）。

## 服务管理

在“服务”页添加、启停、重启、查看日志；**卡片右上角 × 移除**（弹窗内二次确认）。启停只执行每个节点 `actions` 里显式配置的固定命令（`execFile` + `shell:false`，不解析管道或 `&&`）：

```json
"actions": {
  "start":   { "command": "/usr/bin/sudo", "args": ["-n", "/usr/bin/systemctl", "start", "stronghold.service"] },
  "stop":    { "command": "/usr/bin/sudo", "args": ["-n", "/usr/bin/systemctl", "stop", "stronghold.service"] },
  "restart": { "command": "/usr/bin/sudo", "args": ["-n", "/usr/bin/systemctl", "restart", "stronghold.service"] }
}
```

- **脱手运行**：后台启动的本地服务独立于后台进程；后台退出/重启都不停止它们，再次进入后台按 pid 文件识别并继续管理。命令在**后台所在主机**执行（不会在远程 `url` 上执行）。
- **日志**：本地项目读 `data/service-<id>.log`；systemd 读 `journalctl -u <unit>`——需要后台运行账户有 journal 读权限（加入 `systemd-journal` 组），或给该单元配 `NOPASSWD` 的 sudo。
- **systemd 单元名**要写对（如 `stronghold.service`）；名字错误时卡片会显示 `systemd 未找到该服务`。

## 反向代理与 HTTPS

```nginx
location / {
    proxy_pass http://127.0.0.1:7999;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 40s;
}
```

将 `.env` 的 `COOKIE_SECURE=true` 并重启。登录限流按 TCP 对端地址，不信任客户端伪造的代理头。此项目为单管理员后台，没有多账号或 RBAC。

## 插件

内置「资源阈值检查」「卫戍协议 · 定时更新」两个示例。每个插件可添加多个**实例**并绑定到不同服务，各自独立设置与启停；插件在 Worker 中运行（执行隔离，非权限沙箱，只装可信代码）。每次主机采样后调用实例的 `collect(snapshot, context)`，`context` 含该实例的设置、绑定服务与只读的后台快照，返回值按结构展示；实例还可声明 `actions` 按钮。

- 接口、清单与教程：[plugins/README.md](plugins/README.md)
- 定时更新（`git pull` 或官方增量更新包，失败自动回滚）：[plugins/stronghold-updater/README.md](plugins/stronghold-updater/README.md)

## 文档

| 文档 | 内容 |
|---|---|
| [deploy/install-dashboard.sh](deploy/install-dashboard.sh) | 一键部署为 systemd 服务 |
| [deploy/shp-dashboard.service](deploy/shp-dashboard.service) | systemd 模板 |
| [plugins/README.md](plugins/README.md) | 插件清单、接口、多实例与操作按钮 |
| [plugins/stronghold-updater/README.md](plugins/stronghold-updater/README.md) | 定时更新插件（绑定服务、更新/回滚/超时） |
| [config.example.json](config.example.json) · [.env.example](.env.example) | 配置示例 |

## 开发与测试

```bash
npm run dev              # 同时启动后端与 Vite 热更新前端（http://127.0.0.1:5173）
npm test                 # 先构建前端，再跑 node:test（后端、插件、服务、metrics 等）
npm run test:browser     # 可选：本机 Chrome/Edge 端到端验证，截图输出到 artifacts/
```

后端源码改动直接生效（`node src/server.js`），前端改动需 `npm run build`。

## 项目结构

| 路径 | 内容 |
|---|---|
| `src/` | 后端：`server.js`（HTTP/鉴权/路由）、`core.js`（配置校验与健康探针）、`metrics.js`（主机采集）、`services.js`（项目/systemd 服务控制）、`plugins.js` + `plugin-worker.js`（插件系统） |
| `web/` | Vue 3 前端（`App.vue`、`components/`、各页面 CSS） |
| `plugins/` | 示例插件与插件接口说明 |
| `deploy/` | 一键部署脚本与 systemd 模板 |
| `scripts/` | 开发、浏览器冒烟、独立项目启动脚本 |
| `test/` | `node:test` 测试 |
| `dist/` | 前端构建产物（不提交 Git） |

## 链接

- **官方游戏（被管理的对象）**：[sganggs/Stronghold-Protocol](https://github.com/sganggs/Stronghold-Protocol)
- **本项目**：[Summerburier/Stronghold-Protocol-Server-Manager](https://github.com/Summerburier/Stronghold-Protocol-Server-Manager)

其他系统：Windows / macOS 同样是 `npm ci && npm run build && npm start`（PowerShell 用 `Copy-Item`）；独立项目启动脚本见 `scripts/start-service-linux.sh`、`start-service-macos.sh`、`start-service-windows.ps1`。
