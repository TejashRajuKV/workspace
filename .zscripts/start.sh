#!/bin/sh

set -e

# 获取脚本所在目录
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR"

# 存储所有子进程的 PID
pids=""

# 清理函数：优雅关闭所有服务
cleanup() {
    echo ""
    echo "🛑 正在关闭所有服务..."
    
    # 发送 SIGTERM 信号给所有子进程
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            service_name=$(ps -p "$pid" -o comm= 2>/dev/null || echo "unknown")
            echo "   关闭进程 $pid ($service_name)..."
            kill -TERM "$pid" 2>/dev/null
        fi
    done
    
    # 等待所有进程退出（最多等待 5 秒）
    sleep 1
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            # 如果还在运行，等待最多 4 秒
            timeout=4
            while [ $timeout -gt 0 ] && kill -0 "$pid" 2>/dev/null; do
                sleep 1
                timeout=$((timeout - 1))
            done
            # 如果仍然在运行，强制关闭
            if kill -0 "$pid" 2>/dev/null; then
                echo "   强制关闭进程 $pid..."
                kill -KILL "$pid" 2>/dev/null
            fi
        fi
    done
    
    echo "✅ 所有服务已关闭"
    exit 0
}

echo "🚀 开始启动所有服务..."
echo ""

# 切换到构建目录
cd "$BUILD_DIR" || exit 1

ls -lah

DEFAULT_PACKAGED_DB_PATH="/app/db/custom.db"
DEFAULT_PACKAGED_DATABASE_URL="file:$DEFAULT_PACKAGED_DB_PATH"

# Python 依赖在构建阶段安装进部署产物，不复用 Sandbox 的 /home/z/.venv。
# 应用及其启动的子进程都会继承这组路径。
if [ -d "/app/python-runtime/site-packages" ]; then
    export PYTHONPATH="/app/python-runtime/site-packages:/app/app-dist${PYTHONPATH:+:$PYTHONPATH}"
    export PATH="/app/python-runtime/site-packages/bin:$PATH"
    export PYTHONDONTWRITEBYTECODE=1
    export PYTHONUNBUFFERED=1
    echo "🐍 已启用部署包内 Python runtime: $(python --version 2>&1)"
fi

# 启动 Node.js 应用服务器
if [ -f "./app-dist/server/index.js" ]; then
    echo "🚀 启动 Node.js 应用服务器..."
    cd app-dist/ || exit 1
    
    # 设置环境变量
    export NODE_ENV=production
    export PORT="${PORT:-3000}"
    export HOST="${HOST:-0.0.0.0}"
    export HOSTNAME="${HOSTNAME:-0.0.0.0}"
    export DATABASE_URL="${DATABASE_URL:-$DEFAULT_PACKAGED_DATABASE_URL}"

    if [ "$DATABASE_URL" = "$DEFAULT_PACKAGED_DATABASE_URL" ]; then
        if [ ! -f "$DEFAULT_PACKAGED_DB_PATH" ]; then
            echo "❌ 未找到打包后的数据库文件 $DEFAULT_PACKAGED_DB_PATH"
            echo "   为避免生产环境启动到空数据库，启动已终止"
            exit 1
        fi

        echo "🗄️  当前使用打包数据库: $DEFAULT_PACKAGED_DB_PATH"
    else
        echo "🗄️  当前使用外部指定数据库: $DATABASE_URL"
    fi

    if [ ! -f "./dist/client/index.html" ]; then
        echo "❌ 未找到前端构建产物 ./dist/client/index.html"
        echo "   打包流程缺少 npm run build 的结果，启动已终止"
        exit 1
    fi

    # 后台启动 Node.js 应用服务器
    node server/index.js &
    APP_PID=$!
    pids="$APP_PID"
    
    # 等待一小段时间检查进程是否成功启动
    sleep 2
    if ! kill -0 "$APP_PID" 2>/dev/null; then
        echo "❌ Node.js 应用服务器启动失败"
        exit 1
    else
        echo "✅ Node.js 应用服务器已启动 (PID: $APP_PID, Port: $PORT)"
    fi
    
    cd ../
else
    echo "⚠️  未找到 Node.js 应用服务器文件: ./app-dist/server/index.js"
fi

# 协作服务与应用必须共用同一个 SQLite 文件，否则两侧数据会分叉。
if [ -z "${DATABASE_PATH:-}" ]; then
    case "${DATABASE_URL:-}" in
        file:*) DATABASE_PATH="${DATABASE_URL#file:}" ;;
        *) DATABASE_PATH="$DEFAULT_PACKAGED_DB_PATH" ;;
    esac
fi
export DATABASE_PATH
export COLLAB_SERVICE_URL="${COLLAB_SERVICE_URL:-http://127.0.0.1:3004}"
export INTERNAL_TOKEN="${INTERNAL_TOKEN:-iw-internal-token}"

# 启动 mini-services
if [ -f "./mini-services-start.sh" ]; then
    echo "🚀 启动 mini-services..."
    
    # 运行启动脚本（从根目录运行，脚本内部会处理 mini-services-dist 目录）
    sh ./mini-services-start.sh &
    MINI_PID=$!
    pids="$pids $MINI_PID"
    
    # 等待一小段时间检查进程是否成功启动
    sleep 1
    if ! kill -0 "$MINI_PID" 2>/dev/null; then
        echo "⚠️  mini-services 可能启动失败，但继续运行..."
    else
        echo "✅ mini-services 已启动 (PID: $MINI_PID)"
    fi
elif [ -d "./mini-services-dist" ]; then
    echo "⚠️  未找到 mini-services 启动脚本，但目录存在"
else
    echo "ℹ️  mini-services 目录不存在，跳过"
fi

# 启动 Caddy（如果存在 Caddyfile）
echo "🚀 启动 Caddy..."

# Caddy 作为前台进程运行（主进程）
echo "✅ Caddy 已启动（前台运行）"
echo ""
echo "🎉 所有服务已启动！"
echo ""
echo "💡 按 Ctrl+C 停止所有服务"
echo ""

# Caddy 作为主进程运行
exec caddy run --config Caddyfile --adapter caddyfile
