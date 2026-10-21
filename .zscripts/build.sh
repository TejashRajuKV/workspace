#!/bin/bash

# 将 stderr 重定向到 stdout，避免 execute_command 因为 stderr 输出而报错
exec 2>&1

set -e

# 获取脚本所在目录（.zscripts 目录，即 workspace-agent/.zscripts）
# 使用 $0 获取脚本路径（兼容 sh 和 bash）
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# 应用项目路径
PROJECT_DIR="/home/z/my-project"

# 检查应用项目目录是否存在
if [ ! -d "$PROJECT_DIR" ]; then
    echo "❌ 错误: 应用项目目录不存在: $PROJECT_DIR"
    exit 1
fi

echo "🚀 开始构建 Node.js 应用和 mini-services..."
echo "📁 应用项目路径: $PROJECT_DIR"

# 切换到应用项目目录
cd "$PROJECT_DIR" || exit 1

BUILD_DIR="/tmp/build_fullstack_$BUILD_ID"
echo "📁 清理并创建构建目录: $BUILD_DIR"
mkdir -p "$BUILD_DIR"

# 安装依赖
echo "📦 安装依赖..."
npm install

# 明确生成 Prisma Client（部署产物里的 node_modules 必须自带可用的 query engine）
echo "🧬 生成 Prisma Client..."
npm run db:generate

# 构建前端（Vite → dist/client）
echo "🔨 构建前端 (Vite)..."
npm run build

# 校验前端构建产物（部署成功率守卫）。
# 生产服务器直接托管 dist/client；缺失时进程能起来但所有页面 404，
# 所以必须在打包前就失败，不能打出一个"起得来但打不开"的包。
if [ ! -f "dist/client/index.html" ]; then
    echo "❌ 构建失败：未生成 dist/client/index.html，请检查上方 Vite 构建日志。"
    exit 1
fi

# 构建 mini-services
# 检查应用项目目录下是否有 mini-services 目录
if [ -d "$PROJECT_DIR/mini-services" ]; then
    echo "🔨 构建 mini-services..."
    # 使用 workspace-agent 目录下的 mini-services 脚本
    sh "$SCRIPT_DIR/mini-services-install.sh"
    sh "$SCRIPT_DIR/mini-services-build.sh"

    # 复制 mini-services-start.sh 到 mini-services-dist 目录
    echo "  - 复制 mini-services-start.sh 到 $BUILD_DIR"
    cp "$SCRIPT_DIR/mini-services-start.sh" "$BUILD_DIR/mini-services-start.sh"
    chmod +x "$BUILD_DIR/mini-services-start.sh"
else
    echo "ℹ️  mini-services 目录不存在，跳过"
fi

# 将所有构建产物复制到临时构建目录
echo "📦 收集构建产物到 $BUILD_DIR..."

APP_DIST="$BUILD_DIR/app-dist"

# Node.js 应用（服务器 + Prisma schema + 前端产物 + 运行时依赖）
echo "  - 复制 Node.js 应用到 app-dist/"
mkdir -p "$APP_DIST"
cp package.json "$APP_DIST/"
if [ -f "package-lock.json" ]; then
    cp package-lock.json "$APP_DIST/"
fi
cp -r server "$APP_DIST/server"
if [ -d "prisma" ]; then
    cp -r prisma "$APP_DIST/prisma"
fi
cp -r dist "$APP_DIST/dist"
if [ -d "node_modules" ]; then
    cp -r node_modules "$APP_DIST/node_modules"
fi

# .env 不打包：生产环境的 DATABASE_URL / COLLAB_SERVICE_URL 由 start.sh 注入，
# 把开发机的 .env 打进去只会把本机绝对路径带进容器。

# Python 不继承 workspace-agent 的 /home/z/.venv。若项目包含 Python 源码或
# 依赖清单，在构建期将生产依赖固化到产物，并保持 Python 源码的项目相对路径。
PROJECT_DIR="$PROJECT_DIR" BUILD_DIR="$BUILD_DIR" \
    bash "$SCRIPT_DIR/python-runtime-build.sh"

# 有 Preview 数据库时复制现有数据；没有时直接在部署产物中初始化空库。
# 模板源码不携带 db/custom.db，不能依赖 dev.sh 必须在 Deploy 前成功运行过。
PROJECT_DIR="$PROJECT_DIR" BUILD_DIR="$BUILD_DIR" \
    bash "$SCRIPT_DIR/database-runtime-build.sh"

# 复制 Caddyfile（如果存在）
if [ -f "Caddyfile" ]; then
    echo "  - 复制 Caddyfile"
    cp Caddyfile "$BUILD_DIR/"
else
    echo "ℹ️  Caddyfile 不存在，跳过"
fi

# 复制 start.sh 脚本
echo "  - 复制 start.sh 到 $BUILD_DIR"
cp "$SCRIPT_DIR/start.sh" "$BUILD_DIR/start.sh"
chmod +x "$BUILD_DIR/start.sh"

# 打包到 $BUILD_DIR.tar.gz
PACKAGE_FILE="${BUILD_DIR}.tar.gz"
echo ""
echo "📦 打包构建产物到 $PACKAGE_FILE..."
cd "$BUILD_DIR" || exit 1
tar -czf "$PACKAGE_FILE" .
cd - > /dev/null || exit 1

# # 清理临时目录
# rm -rf "$BUILD_DIR"

echo ""
echo "✅ 构建完成！所有产物已打包到 $PACKAGE_FILE"
echo "📊 打包文件大小:"
ls -lh "$PACKAGE_FILE"
