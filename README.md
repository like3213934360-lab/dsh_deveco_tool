# dsh-deveco-tool

HarmonyOS / DevEco 诊断工具集，以 **DeepSeek Harness (DSH) 原生插件** 形式提供。

29 个工具覆盖：设备调试、工程构建、ArkTS 静态检查、LSP 代码导航、UI 自动化、知识检索与文档校验。业务模块在 DSH 进程内直接加载，无中间协议层。

---

## 目录

- [架构](#架构)
- [快速开始](#快速开始)
- [工具清单](#工具清单)
- [依赖](#依赖)
- [开发与测试](#开发与测试)
- [已知限制](#已知限制)
- [Phase 2 增强规划](#phase-2-增强规划)
- [目录结构](#目录结构)
- [许可证](#许可证)

---

## 架构

```
┌─────────────────────────── DSH (DeepSeek Harness) ───────────────────────────┐
│                                                                              │
│   cordis.patch.yml  ──►  loader  ──►  import('/Users/.../dsh_deveco_tool/    │
│   (profile 配置层)              │         src/plugin.mjs')                    │
│                                ▼                                             │
│   ┌──────────────────────────────────────────────────────────────────────┐   │
│   │ src/plugin.mjs  插件入口                                              │   │
│   │  · 遍历 tools-defs.mjs 的 26 个本地工具定义, ctx.tools.register()      │   │
│   │  · 注册 3 个 CodeGenie 代理工具(check_cpp_files / perform_ui_action /  │   │
│   │    get_app_ui_tree), 调用经 callCodeGenieTool 转发                     │   │
│   │  · dispatch(name, args) 按工具名分发到业务模块                          │   │
│   │  · 卸载时清理 LSP / CodeGenie 子进程                                   │   │
│   └──────────────┬───────────────────────────────────────────────────────┘   │
│                  │ 直接函数调用(进程内, 无协议层)                             │
│   ┌──────────────▼───────────────────────────────────────────────────────┐   │
│   │ 业务模块(22 个)                                                        │   │
│   │  arkts-check / deveco-cli / device-ui / hdc-log / lsp /              │   │
│   │  codegenie-client / script-registry / document-validate /           │   │
│   │  modules(auth, knowledge) / ...                                     │   │
│   └──────────────┬───────────────────────────────────────────────────────┘   │
│                  │ spawn(子进程)                                            │
│                  ▼                                                          │
│         hdc / DevEco CLI / ArkTS LSP / CodeGenie child / python / node      │
└──────────────────────────────────────────────────────────────────────────────┘
```

三层设计：

1. **注册层**（`plugin.mjs`）：DSH 插件入口，只做工具注册与分发，不含业务逻辑。
2. **schema 表**（`tools-defs.mjs`）：26 个本地工具的 `name / description / inputSchema` 静态定义（`deveco_script` 的 `enum` 脚本清单在模块加载时动态生成）。
3. **业务模块**（其余 22 个 `.mjs`）：各领域实现——静态检查、构建、设备、UI、LSP、脚本调度、登录、知识检索等，通过 spawn 子进程（hdc / DevEco CLI / LSP / CodeGenie / python / node）完成实际工作。

---

## 快速开始

### 1. 安装依赖

```bash
cd /Users/dreamlike/DreamLike/dsh_deveco_tool
npm install
```

### 2. 接入 DSH（web profile）

在 `~/.dsh/profiles/web/cordis.patch.yml` 追加（保存即热生效，无需重启 DSH）：

```yaml
# 原生插件:devEco/HarmonyOS 诊断工具
- insert:
    - id: dsh-deveco
      name: '/Users/dreamlike/DreamLike/dsh_deveco_tool/src/plugin.mjs'
```

验证配置树：

```bash
dsh --profile web --dump-config   # 应包含 dsh-deveco 条目
```

### 3. 使用

插件加载后，29 个工具以原生工具名出现在会话工具列表中，例如 `deveco_doctor`、`arkts_check`、`ui_snapshot`、`build_project`。

### 4. 运行冒烟测试

```bash
npm run smoke
```

用假的 Cordis ctx 验证 29 个工具全部注册成功，并抽样真实执行 `deveco_script_catalog` / `deveco_status` / `hdc_log list_devices`。

---

## 工具清单

### 环境与状态（5）

| 工具 | 说明 |
|---|---|
| `deveco_doctor` | 检查 DevEco、HDC、项目上下文、Skill 可用性（含 CodeGenie 握手、LSP、CLI 状态） |
| `deveco_status` / `deveco_login` / `deveco_logout` | DevEco 登录态查询 / 打开登录页 / 清除登录会话 |
| `deveco_restart` | 重启长驻子进程（`arkts` = LSP，`cpp` = CodeGenie child，`all` 默认） |

### 脚本调度（2）

| 工具 | 说明 |
|---|---|
| `deveco_script_catalog` | 列出可执行的 skill 脚本（当前 19 个） |
| `deveco_script` | 运行一个注册的 skill 脚本（`args` 具名参数 / `argv` 原始参数，支持 `timeoutMs`） |

### 工程与构建（4）

| 工具 | 说明 |
|---|---|
| `switch_cwd` / `init_project_path` | 设置当前 HarmonyOS 项目根（切换时重置 LSP），二者互为别名 |
| `build_project` | 通过 DevEco CLI 构建项目/模块（支持 `clean`、`log_path` 等，输出为纯文本日志） |
| `start_app` | 部署已构建产物到设备并启动 |

### ArkTS 静态检查（2）

| 工具 | 说明 |
|---|---|
| `arkts_check` | 官方 DevEco ArkTS 静态检查器（指定文件或全项目） |
| `check_ets_files` | 对显式传入的 `.ets/.ts` 文件列表执行检查 |

### LSP / 代码导航（6）

| 工具 | 说明 |
|---|---|
| `lsp` | 原始 LSP 操作（goToDefinition / findReferences / hover / documentSymbol / workspaceSymbol / callHierarchy），1-based 行列、返回原始 LSP 载荷 |
| `go_to_definition` / `find_references` / `get_hover` / `list_symbols` / `find_call_hierarchy` | 上述操作的 1-based 规范化封装 |

### 设备与 UI（5）

| 工具 | 说明 |
|---|---|
| `hdc_log` | `list_devices` / `collect`（按前缀过滤，过滤下推到设备）/ `clear` |
| `ui_snapshot` | 截取设备屏幕（返回图片与报告） |
| `ui_observe` | 一次设备往返同时拿截图 + UI 树 + 可点击坐标（`structureSignature` 判断界面是否变化） |
| `ui_find` | 在 UI 树中定位控件，返回可点击坐标（可复用已有 dump） |
| `ui_tap` | 通过 uitest 发送点击/滑动/按键（优先按 key/text/type 定位，拒绝模糊目标） |

### 知识检索（1）

| 工具 | 说明 |
|---|---|
| `arkts_knowledge_search` | 检索官方 CodeGenie ArkTS/ArkUI/HarmonyOS 知识库 |

### 文档校验（1）

| 工具 | 说明 |
|---|---|
| `document_validate` | 按 SDD 模板校验 spec.md / plan.md / tasks.md 的章节结构（报告，不阻塞） |

### CodeGenie 代理（3）

| 工具 | 说明 |
|---|---|
| `check_cpp_files` | C/C++ 静态语法检查（clangd 诊断），经 CodeGenie child |
| `perform_ui_action` | 统一 UI 操作（click / directionalFling / inputText / keyEvent / screenshot），经 CodeGenie child；未传 `hvd` 且仅一台设备时自动解析 |
| `get_app_ui_tree` | 获取 UI 树（simple / full），经 CodeGenie child |

> 工具列表合计 29 = 26 本地 + 3 CodeGenie 代理。CodeGenie 自带的 `verify_ui` / `save_ui_screenshot` / `get_ui_verification_log`（UI 自动校验链）不注册。

---

## 依赖

| 包 | 用途 |
|---|---|
| `@modelcontextprotocol/sdk` | `codegenie-client.mjs` 作为 MCP client 连接 CodeGenie child（非服务端） |
| `@arkts/language-server` | ArkTS LSP（`lsp.mjs`） |
| `@deveco-codegenie/mcp` | CodeGenie child 入口（按 `REPO_ROOT/node_modules` 解析） |
| `@deveco/deveco-cli` | 构建/部署 CLI（按 `REPO_ROOT` 解析） |
| `vscode-jsonrpc` / `vscode-languageserver-protocol` / `vscode-uri` | LSP 协议实现 |

> 注册使用纯对象 `ToolDefinition`（`ctx.tools.register` 直接接受），不依赖 `@deepseek-ai/dsh-tools` 包。`overrides` 固定 `axios`/`adm-zip` 的安全版本。

---

## 开发与测试

```bash
npm run smoke          # 冒烟:29 工具注册 + 抽样执行
node --check src/*.mjs # 语法检查(全部模块)
```

### 修改流程

1. 改业务模块（`src/*.mjs`）或注册层（`plugin.mjs`）。
2. 跑 `npm run smoke`。
3. 触发 DSH 重载：`touch ~/.dsh/profiles/web/cordis.patch.yml`（配置变化 → HMR 重载插件），或在 GUI 重启会话。
4. 实调验证。

### 工具增删

- **加工具**：在 `tools-defs.mjs` 的 `localTools` 增加 schema 条目（或直接写 `plugin.mjs`），在 `dispatch()` 加分支，`smoke.test.mjs` 的期望列表同步更新。
- **删工具**：从两处移除并更新测试。

---

## 已知限制

- `SKILLS_ROOT` 指向本机固定的外部 skills 目录（`/Users/dreamlike/DreamLike/deveco_tool/skills`，脚本与知识库所在处），该目录不可用时 `deveco_script` 系列会报 `SCRIPT_NOT_FOUND`。
- 依赖 dev 环境：ArkTS LSP、DevEco CLI、hdc、CodeGenie child 均依赖本机 DevEco Studio 安装（`DEVECO_HOME` / `DEVECO_PATH` 自动探测，可用环境变量覆盖；macOS 默认路径为 `/Applications/DevEco-Studio.app/Contents`，其他平台需设置环境变量）。
- Phase 1 输出呈现为 JSON 文本，未启用 DSH 卡片/图片内联。

---

## Phase 2 增强规划

- `presentResult` 卡片：`build_project` → terminal 卡片、`arkts_docs_search` → search 卡片、LSP 诊断 → read 卡片。
- `ui_snapshot` / `ui_observe` 的 render 返回真实 `image` block（视觉模型可直接看到截图）。
- `exec.signal` 传入业务函数，实现端到端取消（hdc/python 子进程随调用中止）。
- `ctx.tools.guard()` 为 `build_project` / `ui_tap` 等危险操作加审批门禁。

---

## 目录结构

```
dsh_deveco_tool/
├── package.json          # 依赖与脚本
├── smoke.test.mjs        # 冒烟测试(假 ctx 注册 + 抽样执行)
├── src/
│   ├── plugin.mjs        # DSH 插件入口(注册层 + dispatch 分发)
│   ├── tools-defs.mjs    # 26 个本地工具 schema 定义表
│   ├── config.mjs        # 路径/环境探测(DevEco home、hdc、skills 根)
│   ├── script-registry.mjs # skill 脚本注册与执行
│   ├── arkts-check.mjs / build-profile.mjs / codegenie-client.mjs /
│   │   codegenie-tools.mjs / deveco-cli.mjs / device-dump.mjs /
│   │   device-input.mjs / device-lock.mjs / device-tar.mjs /
│   │   device-ui.mjs / doctor.mjs / document-validate.mjs /
│   │   hdc-log.mjs / lsp.mjs / process-tree.mjs / project-context.mjs
│   ├── modules/
│   │   ├── auth.mjs      # DevEco 登录(凭证存 ~/.deveco-knowledge-mcp)
│   │   ├── config.mjs    # 登录端点常量
│   │   └── knowledge.mjs # CodeGenie 知识库检索
│   └── upstream/         # 检查器与配套文档(arkts-check.cjs 等)
└── node_modules/         # 依赖(不入库)
```

---

## 许可证

业务模块的许可沿用其来源项目 `deveco_tool`（见 [LICENSE](https://gitcode.com/dream-ship/deveco_tool)）；本仓库其余内容保留所有权利。
