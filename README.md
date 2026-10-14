# SHP Server Manager

卫戍协议独立服务器管理后台：**Node.js 24 LTS + Vue 3 + Vite**，生产构建后由 Node 提供网页与 API，无 CDN。通过游戏原有的 HTTP 健康接口与预设外部命令间接管理，不引用、导入或修改原游戏文件，可单独部署。

## 功能

- 多节点在线状态、响应耗时、版本、运行时长、房间、进行中对局、AI、观战、会话与连接数。
- 主机指标：CPU 总/每核、内存、Swap、负载、磁盘、网卡收发速率/累计/错误、运行时长、后台 RSS；CPU/内存/磁盘达到 90% 页面提示。
- **真人席位 ≠ 严格在线人数**（游戏为断线玩家保留席位，WebSocket 含大厅/观战）；接口没有去重在线数、名单或房间明细，本项目不伪造。
- 监控的是**后台所在主机**；与游戏同机部署即看本机性能，未实现远程采集 Agent。
- 安全：密码登录、8 小时 HttpOnly Cookie、失败限流、跨域写入来源校验、scrypt 带盐哈希；后台重启需重新登录。
- 可选启停/重启：只执行每个节点显式配置的固定命令，二次确认 + 审计日志。**后台启动的服务脱手运行**，后台退出/重启都不停止它们。

## 快速开始（Linux）

```bash
cp .env.example .env
cp config.example.json config.json
npm ci
npm run build
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # 填入 .env 的 ADMIN_PASSWORD
npm start
```

访问 `http://127.0.0.1:7999`，用 `.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD` 登录（保留占位密码会先进入首次初始化页）。改 `config.json` 的 `servers` 指向游戏；游戏未启动时后台仍可运行并显示离线。升级时保留 `.env`、`config.json`、`data/`，`npm ci && npm run build` 后重启。

前端开发：`npm run dev` 同时启动后端与 Vite 热更新（访问 `http://127.0.0.1:5173`）；生产修改 `web/` 后需 `npm run build` 并重启。

## Linux 常驻部署（systemd）

一键（推荐）：

```bash
sudo bash deploy/install-dashboard.sh                  # 默认 127.0.0.1:7999
sudo bash deploy/install-dashboard.sh --host 0.0.0.0   # 对外访问
```

脚本会创建系统用户 `shp-dashboard`、执行 `npm ci` + 构建、准备 `data/`、`.env`（随机初始密码）、`config.json`，写入 `/etc/systemd/system/shp-dashboard.service` 后 `daemon-reload` + `enable --now`，并打印访问地址、初始密码和日志命令。参数：`--name` / `--user` / `--dir` / `--port` / `--host` / `--node`（node 绝对路径，nvm 等 sudo 下找不到 node 时用）/ `--no-build`。

手动：参考模板 `deploy/shp-dashboard.service`，按实际 Node 路径改 `ExecStart` 后 `systemctl daemon-reload && systemctl enable --now shp-dashboard`。

## 配置（config.json）

```json
{
  "pluginsDirectory": "plugins",
  "pollIntervalSeconds": 15,
  "retentionHours": 24,
  "host": { "pollIntervalSeconds": 5, "diskPaths": ["/"], "networkInterfaces": ["eth0"] },
  "servers": [
    { "id": "game", "name": "卫戍协议", "source": "../Stronghold-Protocol" },
    { "id": "web", "name": "Web", "source": "nginx.service", "sudo": true }
  ]
}
```

- `source` 为**目录**（读取 package.json 或官方 `scripts/launch.mjs` 启动）或 **`.service`**（systemd）。
- `url` 可选，仅用于游戏健康数据；**可省略**——project 按 `env.PORT`、systemd 按单元 `Environment`/`ExecStart` 自动推导 `http://127.0.0.1:<端口>`，仍可手动覆盖。
- `projectOptions` 可配 `entry` / `args` / `env`；systemd 的 `sudo: true` 使用非交互 sudo。
- 采样范围：`pollIntervalSeconds` 5–3600、`retentionHours` 1–168、主机 `host.pollIntervalSeconds` 2–60。网卡默认统计所有非回环接口，建议按 ECS 实际名称指定（`ip -br link`）。

环境变量：

| 变量 | 说明 |
| --- | --- |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | 初始账户；密码 ≥8 位，占位值触发首次初始化（兼容旧 `ADMIN_TOKEN`） |
| `HOST` / `PORT` | 默认 `127.0.0.1` / `7999` |
| `CONFIG_FILE` / `DATA_DIR` / `PLUGINS_DIR` | 默认 `config.json` / `data` / `plugins`（相对项目目录） |
| `COOKIE_SECURE` | 使用 HTTPS 时设 `true` |

## 服务管理

在“服务”页添加（本地项目 / systemd / 网络地址）、启停、重启、查看日志。启停只执行节点 `actions` 里显式配置的固定命令（`execFile` + `shell:false`，不解析管道或 `&&`）：

```json
"actions": {
  "start":   { "command": "/usr/bin/sudo", "args": ["-n", "/usr/bin/systemctl", "start", "stronghold.service"] },
  "stop":    { "command": "/usr/bin/sudo", "args": ["-n", "/usr/bin/systemctl", "stop", "stronghold.service"] },
  "restart": { "command": "/usr/bin/sudo", "args": ["-n", "/usr/bin/systemctl", "restart", "stronghold.service"] }
}
```

- 后台启动的本地服务**脱手运行**：后台退出或重启都不会停止它们；再次进入后台按 pid 文件识别并继续管理。命令在**后台所在主机**执行。
- 附带的 `deploy/shp-dashboard.service` 使用 `NoNewPrivileges=true`，会禁止 sudo 提权；需要时改为 `false` 并给运行账户配置精确的 sudo 权限。

## HTTPS 反向代理

```nginx
location / {
    proxy_pass http://127.0.0.1:7999;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 40s;
}
```

`.env` 设 `COOKIE_SECURE=true` 后重启。登录限流按 TCP 对端地址，不信任客户端伪造的代理头。

## 插件

内置“资源阈值检查”和“卫戍协议 · 定时更新”两个示例。每个插件可添加多个**实例**并绑定到不同服务，各自独立设置与启停；插件在 Worker 中运行（执行隔离，非权限沙箱，只装可信代码）。每次主机采样后调用实例的 `collect(snapshot, context)`，`context` 含该实例的设置、绑定服务与只读的后台快照，返回值按结构展示；实例还可声明 `actions` 按钮。接口、清单与教程见 [plugins/README.md](plugins/README.md)；定时更新插件见 [plugins/stronghold-updater/README.md](plugins/stronghold-updater/README.md)。

## API 与测试

`GET /healthz` 仅表示后台存活。需登录：`GET /api/status`、`GET /api/host/history`、`GET /api/history?id=`、`POST /api/servers/:id/actions/start|stop|restart`、`POST /api/logout`。插件：`GET /api/plugins`、`POST /api/plugins/rescan`、`POST /api/plugins/:pluginId/instances`、`POST /api/plugins/instances/:id/enable|disable|settings|remove`、`POST /api/plugins/instances/:id/actions/:key`；历史接口支持 `since=` 毫秒时间戳。

```bash
npm test              # 构建 + Node 测试
npm run test:browser  # 可选：用本机 Chrome/Edge 端到端验证，截图输出到 artifacts/
```

其他系统：Windows/macOS 同样是 `npm ci && npm run build && npm start`（PowerShell 用 `Copy-Item`）；独立项目启动脚本见 `scripts/start-service-linux.sh`、`start-service-macos.sh`、`start-service-windows.ps1`。
