# dsh-deveco-tool

HarmonyOS / DevEco 诊断工具集，以 **DeepSeek Harness (DSH) 原生插件** 形式提供。

29 个工具覆盖：设备调试、工程构建、ArkTS 静态检查、LSP 代码导航、UI 自动化、知识检索与文档校验。业务模块在 DSH 进程内直接加载，无中间协议层。

---

## 目录

- [架构](#架构)
- [前提条件](#前提条件)
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
│   cordis.patch.yml  ──►  loader  ──►  import('dsh-deveco-tool')             │
│   (profile 配置层)              │         (包名, 解析基准 = profile 目录)      │
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

## 前提条件

### 1. 运行时环境

- **Node.js >= 20**（业务模块与插件入口均基于 Node ESM）
- **DeepSeek Harness (DSH)** 已安装并运行（web profile），插件通过 `cordis.patch.yml` 挂载

### 2. DevEco Studio（按功能而定）

底层工具链（`hdc`、hvigor 构建、ArkTS SDK 类型库）随 DevEco Studio 一并安装，`config.mjs` 会自动探测：

- **macOS 默认路径**：`/Applications/DevEco-Studio.app/Contents`（免配置）
- **其他平台**：必须设置环境变量 `DEVECO_HOME` 或 `DEVECO_PATH` 指向 DevEco 安装目录

各功能对 DevEco 的依赖：

| 依赖程度 | 功能 | 说明 |
|---|---|---|
| **必须** | `hdc_log` / `ui_snapshot` / `ui_find` / `ui_observe` / `ui_tap` / `get_app_ui_tree` / `perform_ui_action` / `start_app` | `hdc` 二进制位于 DevEco SDK 内（`sdk/default/openharmony/toolchains/hdc`），可用 `HDC_PATH` 指向其他安装 |
| **必须** | `build_project` / `start_app`（构建部分） | 通过 DevEco CLI 调用 hvigor，需要 SDK（`DEVECO_SDK_HOME` 自动从 DevEco home 推导） |
| **必须（完整分析）** | `arkts_check` / `check_ets_files` / LSP 系列 | 检查器与语言服务器运行时使用 SDK 的 ArkTS 标准库类型；无 SDK 时语言服务器可启动但分析不完整 |
| **不需要** | `deveco_status` / `deveco_login` / `deveco_logout`、`document_validate`、`deveco_script_catalog`、`jscrash_report` / `parse_jscrash_log`、`arkts_docs_search` / `arkui_docs_search` / `search_practices`、`switch_cwd` / `init_project_path`、`deveco_doctor`（报告环境缺失） | 纯分析/状态/本地检索类，不依赖本地 DevEco |

> 设备类功能真正依赖的是 `hdc` 与 OpenHarmony SDK，不依赖 IDE 本身——只装命令行 SDK 并设置 `HDC_PATH` / `DEVECO_HOME` 也可工作。

### 3. HarmonyOS 设备（设备类功能）

`hdc_log` / `ui_*` / `start_app` / `get_app_ui_tree` / `perform_ui_action` 需要连接真机（USB 或网络方式），且能被 `hdc list targets` 识别。无设备时这些工具会报 `HDC_NO_DEVICE`。

### 4. 网络（部分功能）

- `deveco_login` / `deveco_status` / `deveco_logout`：访问华为 DevEco 授权站点
- `arkts_knowledge_search`：调用 CodeGenie 在线检索接口
- `build_project`：首次构建时 `ohpm install` 需要拉取依赖

本地知识库检索（`arkts_docs_search` / `arkui_docs_search` / `search_practices`）与日志分析类不依赖网络。

### 5. Python（可选，部分脚本）

`deveco_script` 中的 10 个诊断脚本（`appfreeze_analyze`、`memleak_analyze`、`arkts_docs_search`、`ui_score` 等）需要 **Python 3** 解释器；`ui_score` 额外需要 **Pillow**。可用 `PYTHON` 环境变量指定解释器（未设置时自动探测 `python3`）。

### 6. 环境变量汇总

| 变量 | 用途 |
|---|---|
| `DEVECO_HOME` / `DEVECO_PATH` | DevEco 安装目录（非 macOS 默认路径时必须设置） |
| `HDC_PATH` | hdc 可执行文件路径（可选，默认从 DevEco SDK 推导） |
| `OHOS_SDK_PATH` | ArkTS LSP 的 SDK 路径（可选，默认从 DevEco home 推导） |
| `PYTHON` | Python 解释器（可选，默认探测 `python3`） |
| `DEVECO_SKILLS_ROOT` | skills 资产根目录（可选，默认用仓库内 `skills/`；设置后即为权威，指向无效目录时不回落） |
| `DEVECO_CODEGENIE_ENTRY` | CodeGenie 子进程入口（测试用，可选） |

---

## 快速开始

### 1. 安装依赖

```bash
cd <REPO>        # 本仓库签出目录
npm install
```

### 2. 接入 DSH（web profile）

DSH 的 loader 用**包名**导入插件，解析基准是 **profile 目录**（`~/.dsh/profiles/<profile>/`），不是 DSH 的安装目录 —— boot 时 `ctx.baseUrl` 被设为 profile 配置文件所在目录，loader 的 `import()` 以它为基准走 Node 的 parent-walk。因此符号链接要建在 profile 的 `node_modules` 下：

```bash
# 用你的实际仓库路径替换 <REPO>
mkdir -p ~/.dsh/profiles/web/node_modules
ln -sfn <REPO> ~/.dsh/profiles/web/node_modules/dsh-deveco-tool
```

> **不要链接到 DSH 安装目录（npx 缓存）下的 `node_modules`。** 那条路径不在 profile 的解析链上，启动会报
> `failed to import loader entry dsh-deveco (dsh-deveco-tool): Cannot find package 'dsh-deveco-tool' imported from ~/.dsh/profiles/web/`；
> 而且 `npm exec @deepseek-ai/dsh` 重建 npx 缓存时会把该目录下的链接清掉。
>
> 注意 profile 的 `node_modules` 由 pnpm 管理（供 out-of-tree 插件使用），而本插件是手工链接、不在 `profiles/web/package.json` 的 `dependencies` 里。若日后跑 `dsh plugin --profile web add/install`，pnpm 有可能修剪掉这个非托管链接 —— 届时重新执行上面的 `ln -sfn` 即可。

再在 `~/.dsh/profiles/web/cordis.patch.yml` 追加（保存即热生效，无需重启 DSH）：

```yaml
# 原生插件:devEco/HarmonyOS 诊断工具
- insert:
    - id: dsh-deveco
      name: 'dsh-deveco-tool'
```

#### profile 层与 home 层 patch 的差异

补丁按 `bundle 层 → profile 层 → home 层 → --patch overlay` 的顺序合成，后者覆盖前者，两个用户层都被热监听：

| 文件 | 作用域 | 说明 |
| --- | --- | --- |
| `~/.dsh/profiles/<profile>/cordis.patch.yml` | 单个 profile | 上面用的就是这层。**不会被启动流程重置** —— profile 初始化只在文件不存在时写入模板 |
| `~/.dsh/cordis.patch.yml` | 所有 profile | 想让插件在 web / headless 等每个 profile 都生效时写这里；默认不存在，需自建 |

> 别把 `cordis.patch.yml` 和同目录的 `cordis.yml` 搞混：后者是 loader 的 leaf root，内容恒为 `[]`，**每次启动都会被重写**，文件头自己写着 "Edit cordis.patch.yml, not this file"。看到它被重置属正常现象，不代表你的插件配置丢了。

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

- skills 资产（19 个脚本 + 知识库，11 个 skill 约 31M）随仓库分发在 `skills/` 下，开箱即用；`DEVECO_SKILLS_ROOT` 可覆盖指向仓库外另一份资产。根目录解析结果与每个脚本的落盘状态见 `deveco_doctor` 的 `environment.skillsRoot*` 与 `scripts`（`rootExists` / `missing` / 每项 `exists`）。资产缺失时 `deveco_script` 报 `SKILLS_ROOT_NOT_FOUND`（整个根找不到）或 `SCRIPT_NOT_FOUND`（单个脚本缺失），两者都带 `hint`。
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
├── skills/               # deveco_script 的 19 个脚本 + 知识库(11 个 skill, 约 31M)
│   ├── arkts-runtime-fix/            hmos-apifault-analysis/
│   ├── arkui-component-best-practices/ hmos-appfreeze-analysis/
│   ├── deveco-create-project/        hmos-arkts-knowledge-retriever/
│   ├── hmos-instrument-test/         hmos-arkui-knowledge-retriever/
│   ├── hmos-local-test/              hmos-memleak-analysis/
│   └── ui-reconstruction-score/
├── patches/              # 上游依赖补丁(见 patches/README)
└── node_modules/         # 依赖(不入库)
```

---

## 许可证

业务模块的许可沿用其来源项目 `deveco_tool`（见 [LICENSE](https://gitcode.com/dream-ship/deveco_tool)）；本仓库其余内容保留所有权利。
