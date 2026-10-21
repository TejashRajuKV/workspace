#!/bin/sh

# 配置项
DIST_DIR="./mini-services-dist"

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
}

# 默认 SQLite 路径：与应用侧 DATABASE_URL 指向同一个文件。
# 服务代码里 __dirname/../../db/custom.db 依赖源码目录结构，
# 打包后的目录层级不同，所以必须显式注入。
if [ -z "${DATABASE_PATH:-}" ]; then
    DATABASE_PATH="/app/db/custom.db"
fi
export DATABASE_PATH

main() {
    echo "🚀 开始启动所有 mini services..."
    
    # 检查 dist 目录是否存在
    if [ ! -d "$DIST_DIR" ]; then
        echo "ℹ️  目录 $DIST_DIR 不存在"
        return
    fi
    
    # 查找已打包的服务目录（每个目录含 index.js 或 src/index.js）
    service_count=0
    for dir in "$DIST_DIR"/mini-services/*/; do
        [ -d "$dir" ] || continue

        entry=""
        for candidate in "$dir"src/index.js "$dir"index.js; do
            if [ -f "$candidate" ]; then
                entry="$candidate"
                break
            fi
        done
        [ -n "$entry" ] || continue

        service_name=$(basename "$dir")
        echo "▶️  启动服务: $service_name..."
        
        # 使用 Node.js 运行服务（后台运行）
        node "$entry" &
        pid=$!
        if [ -z "$pids" ]; then
            pids="$pid"
        else
            pids="$pids $pid"
        fi
        service_count=$((service_count + 1))
        
        # 等待一小段时间检查进程是否成功启动
        sleep 0.5
        if ! kill -0 "$pid" 2>/dev/null; then
            echo "❌ $service_name 启动失败"
            # 从字符串中移除失败的 PID
            pids=$(echo "$pids" | sed "s/\b$pid\b//" | sed 's/  */ /g' | sed 's/^ *//' | sed 's/ *$//')
        else
            echo "✅ $service_name 已启动 (PID: $pid)"
        fi
    done
    
    if [ "$service_count" -eq 0 ]; then
        echo "ℹ️  未找到任何已打包的 mini service"
        return
    fi
    
    # 计算运行中的服务数量
    running_count=0
    for pid in $pids; do
        if kill -0 "$pid" 2>/dev/null; then
            running_count=$((running_count + 1))
        fi
    done
    
    echo ""
    echo "🎉 所有服务已启动！共 $running_count 个服务正在运行"
    echo ""
    echo "💡 按 Ctrl+C 停止所有服务"
    echo ""
    
    # 等待所有后台进程
    wait
}

main
