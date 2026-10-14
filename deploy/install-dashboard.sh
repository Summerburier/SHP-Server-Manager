#!/usr/bin/env bash
# 一键把「本管理后台（SHP-Server-Manager）」部署成 systemd 服务并立即启动。
#
#   sudo bash deploy/install-dashboard.sh
#   sudo bash deploy/install-dashboard.sh --port 7999 --host 0.0.0.0
#
# 会做的事：建系统用户 → npm ci + 构建 → 准备 data/、.env、config.json → 写 <名>.service → enable --now。
# 可选参数：
#   --name <名>    服务名，默认 shp-dashboard
#   --user <用户>  运行用户，默认 shp-dashboard（不存在则创建系统用户）
#   --dir <目录>   后台目录，默认脚本所在仓库根目录
#   --port <端口>  监听端口，默认 7999（写入 .service 的 Environment）
#   --host <地址>  监听地址，默认 127.0.0.1（对外访问用 0.0.0.0）
#   --node <路径>  node 绝对路径（nvm 等 sudo 下找不到 node 时用）
#   --no-build     跳过 npm ci / npm run build（已构建过时用）
set -euo pipefail

NAME=shp-dashboard
SERVICE_USER=shp-dashboard
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=7999
HOST=127.0.0.1
NODE=""
BUILD=1

while [ "$#" -gt 0 ]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --user) SERVICE_USER="$2"; shift 2 ;;
    --dir) ROOT="$(cd -- "$2" && pwd)"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --node) NODE="$2"; shift 2 ;;
    --no-build) BUILD=0; shift ;;
    -h|--help) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $1（--help 查看用法）" >&2; exit 1 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then echo "请用 root 或 sudo 运行。" >&2; exit 1; fi
[ -f "$ROOT/package.json" ] || { echo "在 $ROOT 找不到 package.json，请用 --dir 指定后台目录。" >&2; exit 1; }

# 解析 node / npm：优先 --node，其次 PATH，再退回 sudo 原用户的登录环境（nvm 等）
if [ -z "$NODE" ]; then NODE="$(command -v node || true)"; fi
if [ -z "$NODE" ] && [ -n "${SUDO_USER:-}" ]; then NODE="$(sudo -u "$SUDO_USER" -H bash -lc 'command -v node' 2>/dev/null || true)"; fi
[ -n "$NODE" ] || { echo "找不到 node：请用 --node 指定绝对路径（如 /home/<用户>/.nvm/versions/node/vXX/bin/node）。" >&2; exit 1; }
NPM="$(dirname -- "$NODE")/npm"
[ -x "$NPM" ] || NPM="$(command -v npm || true)"
[ -n "$NPM" ] || { echo "找不到 npm（应与 node 同目录）。" >&2; exit 1; }
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || { echo "Node.js 版本过低（$("$NODE" -v)），需要 22 或更高。" >&2; exit 1; }

# 1) 运行用户
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  echo "已创建系统用户 $SERVICE_USER"
fi

# 2) 依赖与构建
if [ "$BUILD" -eq 1 ]; then
  ( cd "$ROOT" && "$NPM" ci --no-audit --no-fund && "$NPM" run build )
fi

# 3) 数据目录与配置
mkdir -p "$ROOT/data"
chown -R "$SERVICE_USER:$SERVICE_USER" "$ROOT/data"

if [ ! -f "$ROOT/.env" ]; then
  PASSWORD="$("$NODE" -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  printf 'ADMIN_USERNAME=admin\nADMIN_PASSWORD=%s\n' "$PASSWORD" > "$ROOT/.env"
  GENERATED_PASSWORD="$PASSWORD"
fi
if [ ! -f "$ROOT/config.json" ]; then
  if [ -f "$ROOT/config.example.json" ]; then cp "$ROOT/config.example.json" "$ROOT/config.json"
  else printf '{\n  "servers": [],\n  "pluginsDirectory": "plugins"\n}\n' > "$ROOT/config.json"; fi
fi
chown root:"$SERVICE_USER" "$ROOT/.env"
chmod 640 "$ROOT/.env"
chown "$SERVICE_USER":"$SERVICE_USER" "$ROOT/config.json"   # 后台可写回配置（服务管理/设置保存）
chmod 640 "$ROOT/config.json"

# 4) systemd 单元（ROOT 在 /home、/root 下时不启用 ProtectHome，否则服务读不到自己）
UNIT="/etc/systemd/system/${NAME}.service"
PROTECT_HOME="ProtectHome=true"
case "$ROOT" in /home/*|/root/*) PROTECT_HOME="ProtectHome=false" ;; esac
{
  echo "[Unit]"
  echo "Description=SHP independent server dashboard"
  echo "After=network-online.target"
  echo "Wants=network-online.target"
  echo
  echo "[Service]"
  echo "Type=simple"
  echo "User=${SERVICE_USER}"
  echo "Group=${SERVICE_USER}"
  echo "WorkingDirectory=${ROOT}"
  echo "EnvironmentFile=${ROOT}/.env"
  echo "Environment=DATA_DIR=${ROOT}/data CONFIG_FILE=${ROOT}/config.json PORT=${PORT} HOST=${HOST}"
  echo "ExecStart=${NODE} ${ROOT}/src/server.js"
  echo "Restart=on-failure"
  echo "RestartSec=5"
  echo "TimeoutStopSec=40"
  echo "NoNewPrivileges=true"
  echo "PrivateTmp=true"
  echo "ProtectSystem=strict"
  echo "${PROTECT_HOME}"
  echo "ReadWritePaths=${ROOT}/data ${ROOT}/config.json"
  echo "UMask=0077"
  echo
  echo "[Install]"
  echo "WantedBy=multi-user.target"
} > "$UNIT"

systemctl daemon-reload
systemctl enable --now "${NAME}.service"
sleep 1
systemctl --no-pager --full status "${NAME}.service" || true

echo
echo "已部署并启动 ${NAME}.service"
echo "  地址：http://${HOST}:${PORT}    （HOST=127.0.0.1 时仅本机可访问，对外请用 --host 0.0.0.0）"
echo "  登录：用户名 admin"
if [ -n "${GENERATED_PASSWORD:-}" ]; then
  echo "        初始密码：${GENERATED_PASSWORD}    （已写入 ${ROOT}/.env，请登录后尽快修改）"
else
  echo "        密码：沿用已有 ${ROOT}/.env 中的 ADMIN_PASSWORD"
fi
echo "  日志：journalctl -u ${NAME}.service -f"
