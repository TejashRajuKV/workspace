#!/bin/bash

# 配置项
ROOT_DIR="/home/z/my-project"
DIST_DIR="/tmp/build_fullstack_$BUILD_ID/mini-services-dist"

main() {
    echo "🚀 开始批量打包..."
    
    # 检查 rootdir 是否存在
    if [ ! -d "$ROOT_DIR/mini-services" ]; then
        echo "ℹ️  目录 $ROOT_DIR/mini-services 不存在，跳过打包"
        return
    fi
    
    # 创建输出目录（如果不存在）
    mkdir -p "$DIST_DIR"
    
    # 统计变量
    success_count=0
    fail_count=0
    
    # 服务源码里有 ../../src/shared/*.js 这类相对引用（协议常量、校验逻辑），
    # 按源码目录结构原样拷贝比打包成单文件更可靠，也省掉打包器这层依赖。
    if [ -d "$ROOT_DIR/src/shared" ]; then
        mkdir -p "$DIST_DIR/src"
        rm -rf "$DIST_DIR/src/shared"
        cp -r "$ROOT_DIR/src/shared" "$DIST_DIR/src/shared"
        echo "📄 已复制共享模块 src/shared"
    fi
    
    # 遍历 mini-services 目录下的所有文件夹
    for dir in "$ROOT_DIR"/mini-services/*; do
        # 检查是否是目录且包含 package.json
        if [ -d "$dir" ] && [ -f "$dir/package.json" ]; then
            project_name=$(basename "$dir")
            
            # 智能查找入口文件 (按优先级查找)
            entry_path=""
            for entry in "src/index.ts" "index.ts" "src/index.js" "index.js"; do
                if [ -f "$dir/$entry" ]; then
                    entry_path="$entry"
                    break
                fi
            done
            
            if [ -z "$entry_path" ]; then
                echo "⚠️  跳过 $project_name: 未找到入口文件 (index.ts/js)"
                continue
            fi
            
            echo ""
            echo "📦 正在打包: $project_name..."
            
            if [ ! -d "$dir/node_modules" ]; then
                echo "❌ $project_name 缺少 node_modules，请先运行 mini-services-install.sh"
                fail_count=$((fail_count + 1))
                continue
            fi
            
            target="$DIST_DIR/mini-services/$project_name"
            rm -rf "$target"
            mkdir -p "$target"
            
            # 拷贝源码（跳过 node_modules 与日志），再单独带上已安装的依赖
            (
                cd "$dir" \
                    && tar --exclude='./node_modules' \
                           --exclude='./node_modules/**' \
                           --exclude='./*.log' \
                           --exclude='./.env' \
                           -cf - .
            ) | tar -C "$target" -xf -
            cp -r "$dir/node_modules" "$target/node_modules"
            
            if [ ! -f "$target/$entry_path" ]; then
                echo "❌ $project_name 打包后缺少入口 $entry_path"
                fail_count=$((fail_count + 1))
                rm -rf "$target"
                continue
            fi
            
            echo "✅ $project_name 打包成功 -> $target"
            success_count=$((success_count + 1))
        fi
    done
    
    if [ -f ./.zscripts/mini-services-start.sh ]; then
        cp ./.zscripts/mini-services-start.sh "$DIST_DIR/mini-services-start.sh"
        chmod +x "$DIST_DIR/mini-services-start.sh"
    fi
    
    echo ""
    echo "🎉 所有任务完成！"
    if [ $success_count -gt 0 ] || [ $fail_count -gt 0 ]; then
        echo "✅ 成功: $success_count 个"
        if [ $fail_count -gt 0 ]; then
            echo "❌ 失败: $fail_count 个"
        fi
    fi
}

main
