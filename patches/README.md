# DSH 运行时补丁

本目录存放对 DSH 安装包（npx 缓存中的 `@deepseek-ai/*`）的手工补丁。
这些文件不属于任何 git 仓库，**`dsh` 升级/重装后会丢失**，需要重新应用。

## 补丁清单

| 补丁 | 目标文件 | 作用 |
|---|---|---|
| `dsh-llm-pi-ai-image-strip.patch` | `node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js` | 模型不支持图片输入时，从请求中丢弃 image 块并继续，而不是让整个会话报错（`UNSUPPORTED_CONTENT`） |

## 重新应用方法

在 DSH 安装根目录（`lib/index.js` 的上一级，即包含 `node_modules/` 的目录）执行：

```bash
cd /Users/dreamlike/.npm/_npx/<当前npx缓存目录>   # 或 dsh 新安装位置
patch -p1 < /path/to/dsh_deveco_tool/patches/dsh-llm-pi-ai-image-strip.patch
```

若提示 `Reversed (or previously applied) patch detected`，说明补丁已应用过，跳过即可。

应用后验证（应输出两处匹配）：

```bash
grep -c "stripImageBlocks" node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js
grep -c "dropping image blocks" node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js
```

然后重启 `dsh web` 服务器生效。

## 说明

- 补丁基于 `@deepseek-ai/dsh@0.1.0-rc.6` 的构建产物生成；若新版本源码结构变化导致
  `patch` 失败（hunk 不匹配），需要按同样的逻辑重新生成补丁：
  1. 在 `@deepseek-ai/dsh-llm-pi-ai/lib/index.js` 的 `stream()` 中，把
     `if (containsImage && !model.input.includes("image")) throw new LlmError(...)`
     改为丢弃 image 块后继续（见补丁内容）；
  2. 补丁已通过回放验证：`patch -p1` 应用后与当时线上文件字节一致。
