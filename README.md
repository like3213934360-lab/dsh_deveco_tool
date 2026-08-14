# dsh-deveco-tool

HarmonyOS / DevEco 诊断工具集，以 **DeepSeek Harness (DSH) 原生插件** 形式提供。

本仓库从 [`deveco_tool`](https://gitcode.com/dream-ship/deveco_tool)（一个统一的 stdio MCP 网关）**提取**而来：29 个工具的业务逻辑全部复用，只把 MCP 协议层替换为 DSH 的插件注册层。**原项目未被改动**，仍可继续作为 MCP 服务器供其他 AI 宿主使用。

---

## 目录

- [背景与动机](#背景与动机)
- [架构](#架构)
- [快速开始](#快速开始)
- [工具清单](#工具清单)
- [与原 MCP 网关的关系](#与原-mcp-网关的关系)
- [依赖](#依赖)
- [开发与测试](#开发与测试)
- [已知限制](#已知限制)
- [Phase 2 增强规划](#phase-2-增强规划)
- [目录结构](#目录结构)

---

## 背景与动机

`deveco_tool` 原本是一个 stdio MCP 服务器（`src/server.mjs` + 22 个业务模块），通过 DSH 的 `dsh-mcp-client` 插件桥接使用。桥接方案可行，但存在一些固有限制：

| 方面 | MCP 桥接（原方案） | 原生插件（本仓库） |
|---|---|---|
| 工具命名 | `mcp__deveco__arkts_check`（带前缀、被规范化） | `arkts_check`（直接原名） |
| 输出契约 | MCP 通用 schema，只做基础校验 | 每个工具声明规范输出 schema（`output.schema` + `render`） |
| 取消/超时 | `toolCallTimeoutMs` 一刀切，服务器侧执行可能残留 | `execute(args, exec)` 收到 `exec.signal`，协作式取消端到端可达 |
| 中间进程 | DSH ↔ MCP server 之间一层长驻进程 + JSON-RPC | 业务模块直接在 DSH 进程内加载，无中间进程 |
| DSH 生态 | 只能作为普通 MCP 工具 | 可接入 `ctx.tools.guard()` 门禁、事件订阅、上下文注入等 |
| 迭代 | 改代码需重启 MCP server 进程 | 改代码后触发配置 HMR 重载即可 |

提取时遵循的原则：

1. **原项目零改动**：`/Users/dreamlike/DreamLike/deveco_tool` 的任何文件都不修改，其 MCP 形态继续可用。
2. **行为等价优先**：本插件的 Phase 1 与 MCP 版行为逐条对应（工具 schema 逐字提取、错误码、返回结构一致），增强能力放入 Phase 2。
3. **大文件不复制**：43M 的 `skills/` 目录不复制，只读引用原项目路径。

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
│   │  · dispatch(name, args) 按工具名分发到业务模块(对应原 server.mjs 的     │   │
│   │    callTool 分支, 逐条等价)                                            │   │
│   │  · 卸载时清理 LSP / CodeGenie 子进程                                   │   │
│   └──────────────┬───────────────────────────────────────────────────────┘   │
│                  │ 直接函数调用(进程内, 无协议层)                             │
│   ┌──────────────▼───────────────────────────────────────────────────────┐   │
│   │ 业务模块(22 个, 从 deveco_tool 逐字提取, 零改动)                        │   │
│   │  arkts-check / deveco-cli / device-ui / hdc-log / lsp /              │   │
│   │  codegenie-client / script-registry / document-validate /           │   │
│   │  modules(auth, knowledge) / ...                                     │   │
│   └──────────────┬───────────────────────────────────────────────────────┘   │
│                  │ spawn(子进程, 与 MCP 版一致)                              │
│                  ▼                                                          │
│         hdc / DevEco CLI / ArkTS LSP / CodeGenie child / python / node      │
└──────────────────────────────────────────────────────────────────────────────┘
```

三层设计：

1. **注册层**（`plugin.mjs`）：DSH 插件入口，只做工具注册与分发，不含业务逻辑。
2. **schema 表**（`tools-defs.mjs`）：26 个本地工具的 `name / description / inputSchema`，用脚本从原 `server.mjs` 的 `localTools` 数组**逐字提取**，保证与 MCP 版 schema 完全一致（`deveco_script` 的 `enum: scriptIds` 依赖已同步注入）。
3. **业务模块**（其余 22 个 `.mjs`）：与原项目逐字相同，唯一的内部改动是 `config.mjs` 的 `SKILLS_ROOT` 指向原项目 skills 目录、`script-registry.mjs` 的 `scriptPath()` 相应改用 `SKILLS_ROOT`（见 [与原 MCP 网关的关系](#与原-mcp-网关的关系)）。

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
# 原生插件:deveco_tool 提取的 DSH 插件
- insert:
    - id: dsh-deveco
      name: '/Users/dreamlike/DreamLike/dsh_deveco_tool/src/plugin.mjs'
```

验证配置树：

```bash
dsh --profile web --dump-config   # 应包含 dsh-deveco 条目
```

### 3. 使用

插件加载后，29 个工具以**原生工具名**（无前缀）出现在会话工具列表中，例如 `deveco_doctor`、`arkts_check`、`ui_snapshot`、`build_project`。

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

> 工具列表合计 29 = 26 本地 + 3 CodeGenie 代理。CodeGenie 自带的 `verify_ui` / `save_ui_screenshot` / `get_ui_verification_log`（UI 自动校验链）与原 MCP 一致地**不注册**。

---

## 与原 MCP 网关的关系

### 提取方式

- **逐字复制**：22 个业务模块 + `upstream/` 与原项目 `src/` 完全一致（本次提取时原项目工作区干净，`hilog -x → -z` 修复等历史改动均已随复制带入）。
- **协议层替换**：原 `server.mjs`（MCP Server / StdioServerTransport / callTool 分发）不复制，改为 `plugin.mjs` 的 `ctx.tools.register()` 注册 + `dispatch()` 分发，逻辑逐条对应。
- **schema 提取**：`tools-defs.mjs` 用脚本从原 `server.mjs` 的 `localTools` 数组提取，保证与 MCP 版完全一致。

### 共享与引用

| 资源 | 处理方式 |
|---|---|
| `skills/`（43M，19 个脚本 + 知识库） | **只读引用**：`config.mjs` 的 `SKILLS_ROOT = "/Users/dreamlike/DreamLike/deveco_tool/skills"`。原项目路径变更时需同步修改 |
| 登录凭证 | 共享 `~/.deveco-knowledge-mcp/auth.json`，与 MCP 版登录态互通 |
| 设备截图/锁 | `os.tmpdir()/deveco-ui/<device>/`，与 MCP 版共用（互斥锁保证不冲突） |
| CodeGenie child | 各自进程独立 spawn（`REPO_ROOT/node_modules/@deveco-codegenie/mcp`），互不影响 |

### 共存与切换

- 工具名不冲突：MCP 桥接注册为 `mcp__deveco__*`，本插件注册为原名。
- 过渡期可同时挂载两者；验证原生工具行为一致后，从 `cordis.patch.yml` 移除 `mcp-deveco` 条目即可完成切换（保存即生效）。

---

## 依赖

| 包 | 用途 |
|---|---|
| `@modelcontextprotocol/sdk` | 仅 `codegenie-client.mjs` 作为 **MCP client** 连接 CodeGenie child（并非服务端） |
| `@arkts/language-server` | ArkTS LSP（`lsp.mjs`） |
| `@deveco-codegenie/mcp` | CodeGenie child 入口（`codegenie-client.mjs` 按 `REPO_ROOT/node_modules` 解析） |
| `@deveco/deveco-cli` | 构建/部署 CLI（`deveco-cli.mjs` 按 `REPO_ROOT` 解析） |
| `vscode-jsonrpc` / `vscode-languageserver-protocol` / `vscode-uri` | LSP 协议实现 |

> 刻意**不依赖** `@deepseek-ai/dsh-tools`：注册使用纯对象 `ToolDefinition`（`dsh-mcp-client` 同款做法），规避 npm registry 版本与 DSH 内置版本不一致的风险。`overrides` 保留原项目的 `axios`/`adm-zip` 安全版本固定。

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

- `SKILLS_ROOT` 硬编码原项目绝对路径；原 `deveco_tool` 仓库移动/改名后需同步修改 `src/config.mjs`。
- 依赖 dev 环境：ArkTS LSP、DevEco CLI、hdc、CodeGenie child 均为本机 DevEco Studio 安装（`DEVECO_HOME` / `DEVECO_PATH` 自动探测，可用环境变量覆盖）。
- Phase 1 输出呈现为 JSON 文本（与 MCP 版一致），未启用 DSH 卡片/图片内联。

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
│   ├── plugin.mjs        # DSH 插件入口(注册层 + dispatch 分发)  [新写]
│   ├── tools-defs.mjs    # 26 个本地工具 schema 表             [提取自 server.mjs]
│   ├── config.mjs        # 路径/环境探测; SKILLS_ROOT 指向原项目  [1 处修改]
│   ├── script-registry.mjs # 19 个 skill 脚本注册与执行          [路径改用 SKILLS_ROOT]
│   ├── arkts-check.mjs / build-profile.mjs / codegenie-client.mjs /
│   │   codegenie-tools.mjs / deveco-cli.mjs / device-dump.mjs /
│   │   device-input.mjs / device-lock.mjs / device-tar.mjs /
│   │   device-ui.mjs / doctor.mjs / document-validate.mjs /
│   │   hdc-log.mjs / lsp.mjs / process-tree.mjs / project-context.mjs
│   ├── modules/
│   │   ├── auth.mjs      # DevEco 登录(凭证存 ~/.deveco-knowledge-mcp)
│   │   ├── config.mjs    # 登录端点常量
│   │   └── knowledge.mjs # CodeGenie 知识库检索
│   └── upstream/         # 上游提取的检查器/文档(arkts-check.cjs 等)
└── node_modules/         # 依赖(不入库)
```

---

## 许可证

遵循原 `deveco_tool` 仓库的许可条款（业务模块逐字提取自该仓库，详见其 [LICENSE](https://gitcode.com/dream-ship/deveco_tool)）。
