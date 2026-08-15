/**
 * @file plugin.mjs
 * @author dreamlike
 *
 * DSH 原生插件入口:把 deveco_tool 的 29 个工具注册为 DSH 工具。
 * 业务模块提取自上游 deveco_tool 项目(原项目未改动),
 * 工具 schema 表逐字来自 tools-defs.mjs(提取自原 server.mjs 的 localTools)。
 *
 * Phase 2 增强:
 *  - exec.signal 端到端取消: dispatch 把调用方 AbortSignal 透传给业务函数,
 *    子进程(hdc / DevEco CLI / 脚本 / ArkTS 检查器 / CodeGenie / 知识检索 fetch)
 *    随调用中止。
 *  - ui_snapshot / ui_observe 的 render 返回真实 image block: execute 将截图
 *    存为附件(ctx.attachments.saveImage), render 输出 {type:"image"} 块,
 *    视觉模型可直接看到截图。
 *  - presentResult 卡片: build_project/start_app → terminal 卡片,
 *    arkts_knowledge_search → search 卡片, arkts_check/check_ets_files → read 卡片。
 *  - 启动时自动清扫: 删除未被任何会话引用的附件对象与本地超时截图
 *    (见 attachment-gc.mjs), 避免截图/附件无限累积。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sweepOnce } from "./attachment-gc.mjs";
import { runRegisteredScript, scriptsStatus } from "./script-registry.mjs";
import { setProjectPath } from "./project-context.mjs";
import { collectDoctorReport } from "./doctor.mjs";
import { searchKnowledge } from "./modules/knowledge.mjs";
import { login, logout, authStatus } from "./modules/auth.mjs";
import { runArktsCheck } from "./arkts-check.mjs";
import { buildProject, startApp } from "./deveco-cli.mjs";
import { hdcLog } from "./hdc-log.mjs";
import {
  findReferences,
  lspOperation,
  goToDefinition,
  getHover,
  listSymbols,
  findCallHierarchy,
  resetLsp,
  shutdownLsp,
} from "./lsp.mjs";
import { validateDocument } from "./document-validate.mjs";
import { uiSnapshot, uiObserve, uiFind, uiTap } from "./device-ui.mjs";
import {
  callCodeGenieTool,
  closeCodeGenie,
  getCodeGenieTools,
  resetCodeGenieCircuit,
} from "./codegenie-client.mjs";
import { PROXIED_CODEGENIE_TOOLS } from "./codegenie-tools.mjs";
import { localTools } from "./tools-defs.mjs";


// CodeGenie 也自带这些工具,但本插件自己实现,隐藏代理副本避免同名双实现。
const LOCAL_OVERRIDE_TOOLS = ["init_project_path", "check_ets_files", "build_project", "start_app"];
// UI 自动校验链不属于本插件; 原 MCP 将它们从工具列表隐藏, 此处保持一致(不注册)。
const DISABLED_CODEGENIE_TOOLS = ["verify_ui", "save_ui_screenshot", "get_ui_verification_log"];

for (const tool of PROXIED_CODEGENIE_TOOLS) {
  if (LOCAL_OVERRIDE_TOOLS.includes(tool.name) || DISABLED_CODEGENIE_TOOLS.includes(tool.name)) {
    throw new Error(`${tool.name} is proxied to CodeGenie but is also overridden or disabled locally`);
  }
}

// 惰性解析 CodeGenie 工具列表,复用同一 child; 失败后重置以便下次重试(与原 server 行为一致)。
let codegenieToolsPromise = null;
function codegenieTools() {
  if (!codegenieToolsPromise) {
    codegenieToolsPromise = getCodeGenieTools().catch((error) => {
      console.error(`[dsh-deveco-tool] ${error.code}: ${error.message}`);
      codegenieToolsPromise = null;
      return [];
    });
  }
  return codegenieToolsPromise;
}

/**
 * 把业务抛错转换成 DSH 可见的错误结果(等价原 MCP 的 {code,message,hint} 错误返回)。
 */
function fail(message, code, hint) {
  const error = new Error(message);
  if (code !== undefined) error.code = code;
  if (hint !== undefined) error.hint = hint;
  throw error;
}

/**
 * 构造一个 DSH 工具注册定义。
 *
 * @param name 工具名
 * @param description 工具描述
 * @param parameters 参数 JSON Schema(直接复用原 MCP inputSchema)
 * @param execute 执行函数 (args, exec) => Promise<JsonValue> | JsonValue
 * @param {{textOnly?: boolean, render?: (args, value) => ContentBlock[],
 *   presentCall?: (args) => ToolCallView|undefined, presentResult?: (args, result) => ToolResultView|undefined,
 *   presentationMeta?: (args, value) => JsonValue|undefined}} [options] 输出声明与 UI 呈现。
 * @returns 工具定义对象
 */
function defineTool(name, description, parameters, execute, options = {}) {
  const textOnly = options.textOnly === true;
  const defaultRender = textOnly
    ? (_args, value) => [{ type: "text", text: value }]
    : (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }];
  const tool = {
    name,
    description,
    parameters,
    output: {
      schema: textOnly ? { type: "string" } : { type: "object", additionalProperties: true },
      render: options.render ?? defaultRender,
      ...(options.presentationMeta !== undefined ? { presentationMeta: options.presentationMeta } : {}),
    },
    execute,
  };
  if (options.presentCall !== undefined) tool.presentCall = options.presentCall;
  if (options.presentResult !== undefined) tool.presentResult = options.presentResult;
  return tool;
}

/**
 * 按工具名分发执行,逻辑逐条对应原 server.mjs 的 callTool 分支。
 * 所有产生子进程/网络请求的分支都接收 exec.signal 并透传,实现端到端取消。
 *
 * @param name 工具名
 * @param args 参数对象
 * @param exec DSH 执行上下文(携带调用方 AbortSignal)
 * @returns 规范 JSON 值或字符串
 */
async function dispatch(name, args, exec) {
  const signal = exec?.signal;
  switch (name) {
    case "deveco_script_catalog": {
      // 带上 skills 根与每个脚本的 exists: 目录整个缺失时, 光看一份静态清单会以为都能跑。
      const status = scriptsStatus();
      return {
        scripts: status.scripts,
        count: status.scripts.length,
        skillsRoot: status.root,
        skillsRootSource: status.rootSource,
        skillsRootExists: status.rootExists,
        missing: status.missing,
      };
    }
    case "deveco_script": {
      if (typeof args.script !== "string") {
        fail("script is required", "SCRIPT_REQUIRED");
      }
      const result = await runRegisteredScript(args.script, { ...args, signal });
      if (!result.ok) {
        fail(result.stderr || `script ${args.script} failed`, "SCRIPT_FAILED");
      }
      return result;
    }
    case "switch_cwd":
    case "init_project_path": {
      const project = setProjectPath(args.project_path);
      await resetLsp();
      return { tool: name, ...project };
    }
    case "deveco_restart": {
      const target = args.target === undefined ? "all" : args.target;
      if (target !== "arkts" && target !== "cpp" && target !== "all") {
        fail('target must be "arkts", "cpp", or "all"', "BAD_TARGET");
      }
      const restarted = [];
      if (target === "arkts" || target === "all") {
        await resetLsp();
        restarted.push("arkts");
      }
      if (target === "cpp" || target === "all") {
        await closeCodeGenie();
        resetCodeGenieCircuit();
        restarted.push("cpp");
      }
      return {
        tool: name,
        target,
        restarted,
        note: "Children are respawned lazily on the next call that needs them.",
      };
    }
    case "deveco_doctor":
      return collectDoctorReport({ loadCodeGenieTools: codegenieTools });
    case "arkts_knowledge_search": {
      if (typeof args.question !== "string" || args.question.trim() === "") {
        fail("question must be a non-empty string", "QUESTION_REQUIRED");
      }
      return { question: args.question, answer: await searchKnowledge(args.question, signal) };
    }
    case "deveco_login": {
      const user = await login();
      return { loggedIn: true, userId: user.userId, userName: user.userName };
    }
    case "deveco_logout":
      await logout();
      return { loggedIn: false };
    case "deveco_status":
      return authStatus();
    case "arkts_check":
      return runArktsCheck({ ...args, signal });
    case "check_ets_files":
      if (!Array.isArray(args.files)) {
        fail("files must be an array of .ets or .ts paths", "ARKTS_FILES_INVALID");
      }
      return runArktsCheck({ files: args.files, signal });
    case "build_project":
      return buildProject({ ...args, signal });
    case "start_app":
      return startApp({ ...args, signal });
    case "hdc_log":
      return hdcLog({ ...args, signal });
    case "find_references":
      return findReferences(args);
    case "lsp":
      return lspOperation(args);
    case "go_to_definition":
      return goToDefinition(args);
    case "get_hover":
      return getHover(args);
    case "list_symbols":
      return listSymbols(args);
    case "find_call_hierarchy":
      return findCallHierarchy(args);
    case "document_validate":
      return validateDocument(args);
    case "ui_snapshot":
      return uiSnapshot({ ...args, signal });
    case "ui_observe":
      return uiObserve({ ...args, signal });
    case "ui_find":
      return uiFind({ ...args, signal });
    case "ui_tap":
      return uiTap({ ...args, signal });
    default:
      fail(`Unknown tool: ${name}`, "UNKNOWN_TOOL");
  }
}

/**
 * 语言提示:从 .ets/.ts 文件路径推导 read 卡片的语法高亮语言。
 * @param {string} filePath 文件路径
 * @returns {string|undefined} 语言名,未知扩展名返回 undefined
 */
function langFromPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ets" || ext === ".ts" || ext === ".mts" || ext === ".cts") return "ts";
  if (ext === ".c" || ext === ".h" || ext === ".cpp" || ext === ".hpp" || ext === ".cc") return "cpp";
  if (ext === ".py") return "py";
  if (ext === ".json") return "json";
  if (ext === ".md") return "markdown";
  if (ext === ".mjs" || ext === ".js") return "js";
  return undefined;
}

/**
 * 判断当前调用方模型是否支持图片输入。
 * 优先读会话已持久化的请求路由(session.requestHeader().config),
 * 缺失时回退到全局默认模型选择(agentDefaultModel); 两者都不可得或
 * 能力查询失败时按不支持处理(保守策略: 宁可少发图, 不能让会话报错)。
 *
 * @param ctx DSH 上下文(用于 ctx.get("llm") / ctx.get("agentDefaultModel"))
 * @param exec 工具执行上下文(携带调用方 agent)
 * @returns {Promise<boolean>} 模型 inputModalities 是否包含 "image"
 */
async function modelSupportsImages(ctx, exec) {
  const llm = ctx.get("llm");
  if (llm === undefined) return false;
  let provider;
  let model;
  const header = exec?.agent?.session?.requestHeader?.();
  const route = header?.config;
  if (typeof route?.provider === "string" && typeof route?.model === "string") {
    provider = route.provider;
    model = route.model;
  } else {
    const selection = ctx.get("agentDefaultModel")?.currentSelection();
    provider = selection?.provider;
    model = selection?.model;
  }
  if (typeof provider !== "string" || typeof model !== "string") return false;
  try {
    const info = await llm.resolveModelInfo(provider, model);
    return Array.isArray(info.inputModalities) && info.inputModalities.includes("image");
  } catch (error) {
    console.warn(`[dsh-deveco-tool] model capability lookup failed (${provider}/${model}): ${error.message}`);
    return false;
  }
}

/**
 * 把 ui_snapshot / ui_observe 的截图存为附件,并把引用附加到返回值。
 * render 据此输出真实 image block; 附件不可用(无服务/超限/读取失败)时
 * 静默降级为纯文本,不影响工具本身的成功结果。当前模型不支持图片输入时
 * 同样降级(不保存附件、不输出 image block),避免整个会话报错。
 *
 * @param ctx DSH 上下文(用于 ctx.attachments)
 * @param exec 工具执行上下文(用于判断模型能力)
 * @param value 工具返回值(含 localPath/mimeType)
 * @returns {Promise<object>} 附加 imageAttachment 后的返回值
 */
async function attachSnapshotImage(ctx, exec, value) {
  if (!value || typeof value.localPath !== "string" || !value.localPath || !(value.bytes > 0)) {
    return value;
  }
  if (!(await modelSupportsImages(ctx, exec))) {
    return value;
  }
  const attachments = ctx.get("attachments");
  if (attachments === undefined) return value;
  let data;
  try {
    data = fs.readFileSync(value.localPath);
  } catch {
    return value;
  }
  const mediaType = value.mimeType === "image/png" ? "image/png" : "image/jpeg";
  try {
    const ref = await attachments.saveImage({ data, mediaType, name: path.basename(value.localPath) });
    return { ...value, imageAttachment: ref };
  } catch (error) {
    console.error(`[dsh-deveco-tool] attachment save failed: ${error.message}`);
    return value;
  }
}

/**
 * DSH 插件入口:注册 26 个本地工具 + 3 个 CodeGenie 代理工具。
 * 以 cordis namespace 插件形式导出(name/inject/apply), inject 声明 tools 服务,
 * 否则访问 ctx.tools 会抛 "cannot get property without inject"。
 */
const name = "dsh-deveco-tool";
const inject = ["tools"];

async function apply(ctx) {
  // LSP 家族返回纯文本行(与 MCP 版一致),必须声明 textOnly,否则 DSH 按
  // object 校验输出会报 "value must be an object"。
  const textOnlyTools = new Set([
    "build_project",
    "start_app",
    "find_references",
    "go_to_definition",
    "get_hover",
    "list_symbols",
    "find_call_hierarchy",
  ]);
  // 截图类工具: render 输出真实 image block(视觉模型可直接看到截图)。
  const snapshotTools = new Set(["ui_snapshot", "ui_observe"]);

  for (const tool of localTools) {
    const toolName = tool.name;
    const isSnapshot = snapshotTools.has(toolName);
    ctx.tools.register(defineTool(
      tool.name,
      tool.description,
      tool.inputSchema,
      async (args, exec) => {
        const value = await dispatch(toolName, args, exec);
        return isSnapshot ? await attachSnapshotImage(ctx, exec, value) : value;
      },
      {
        textOnly: textOnlyTools.has(toolName),
        ...(isSnapshot ? {
          render: (_args, value) => {
            const blocks = [];
            if (value && value.imageAttachment) {
              blocks.push({ type: "image", attachment: value.imageAttachment });
            }
            const { imageAttachment, ...rest } = value ?? {};
            blocks.push({ type: "text", text: JSON.stringify(rest, null, 2) });
            return blocks;
          },
        } : {}),
        ...(toolName === "build_project" || toolName === "start_app" ? {
          // terminal 卡片: pending 显示命令,完成显示输出。
          presentCall: (args) => ({
            card: "terminal",
            title: toolName === "build_project" ? "devecocli build" : "devecocli run",
            description: tool.description,
            ...(typeof args.project_path === "string" ? { cwd: args.project_path } : {}),
          }),
          presentResult: (_args, result) => {
            if (result.isError) return undefined;
            const text = result.content[0]?.type === "text" ? result.content[0].text : undefined;
            if (text === undefined) return undefined;
            return { card: "terminal", output: text };
          },
        } : {}),
        ...(toolName === "arkts_knowledge_search" ? {
          // search 卡片: 把知识检索 answer 里的分节文本投影为可展开的结果列表。
          presentationMeta: (_args, value) => {
            if (!value || typeof value.answer !== "string") return undefined;
            const sections = value.answer.split(/\[\d+\]/).map((s) => s.trim()).filter(Boolean);
            if (sections.length === 0) return undefined;
            const paths = sections.map((s) => {
              const title = /网页标题：([^|]+)/.exec(s)?.[1]?.trim();
              return title || s.slice(0, 60);
            });
            return { paths, total: paths.length, truncated: false };
          },
          presentResult: (_args, result) => {
            if (result.isError) return undefined;
            const meta = result.meta;
            if (meta === undefined || !Array.isArray(meta.paths)) return undefined;
            return {
              card: "search",
              shape: "paths",
              paths: meta.paths,
              truncated: meta.truncated === true,
              total: meta.total,
            };
          },
        } : {}),
        ...(toolName === "arkts_check" || toolName === "check_ets_files" ? {
          // read 卡片: 检查诊断按文件行号呈现(仅单文件检查时投影)。
          presentationMeta: (_args, value) => {
            if (!value || !Array.isArray(value.errors) || value.errors.length === 0) return undefined;
            const byFile = new Map();
            for (const error of value.errors) {
              const file = error.file;
              if (typeof file !== "string") continue;
              if (!byFile.has(file)) byFile.set(file, []);
              byFile.get(file).push(error);
            }
            if (byFile.size !== 1) return undefined;
            const [[file, errors]] = byFile;
            const lines = errors
              .map((error) => ({
                number: error.line,
                text: `[${error.severity ?? "info"}] ${error.message}`,
              }))
              .sort((a, b) => a.number - b.number);
            return {
              path: file,
              offset: lines[0]?.number ?? 1,
              lines,
              totalLines: lines[lines.length - 1]?.number ?? 1,
              ...(langFromPath(file) !== undefined ? { lang: langFromPath(file) } : {}),
            };
          },
          presentResult: (_args, result) => {
            if (result.isError) return undefined;
            const meta = result.meta;
            if (meta === undefined || !Array.isArray(meta.lines)) return undefined;
            return {
              card: "read",
              path: meta.path,
              offset: meta.offset,
              lines: meta.lines,
              totalLines: meta.totalLines,
              ...(meta.lang !== undefined ? { lang: meta.lang } : {}),
            };
          },
        } : {}),
      },
    ));
  }

  // CodeGenie 代理工具: schema 来自静态表, 调用时经 callCodeGenieTool 转发。
  for (const tool of PROXIED_CODEGENIE_TOOLS) {
    ctx.tools.register(defineTool(
      tool.name,
      tool.description,
      tool.inputSchema,
      async (args, exec) => {
        // CodeGenie 把已安装但未运行的模拟器当作可选目标且强制要求 hvd,
        // 而 get_app_ui_tree 会自动选设备; 这里与原 server 一致地自动解析。
        if (tool.name === "perform_ui_action" && !args.hvd) {
          const { devices } = await hdcLog({ action: "list_devices" });
          if (devices.length === 0) {
            fail("No connected HarmonyOS devices detected.", "HDC_NO_DEVICE");
          }
          if (devices.length > 1) {
            fail(`Multiple HarmonyOS devices are connected (${devices.join(", ")}); pass hvd.`, "HDC_DEVICE_REQUIRED");
          }
          return callCodeGenieTool(tool.name, { ...args, hvd: devices[0] }, exec?.signal);
        }
        return callCodeGenieTool(tool.name, args, exec?.signal);
      },
    ));
  }

  // 附件库与本地截图自动清扫: 启动时一次性尽力执行, 不阻塞插件加载。
  // 删除未被任何会话引用的附件对象(存在超过 1 小时)与本地超时截图。
  setTimeout(() => {
    const dshHome = process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh");
    const swept = sweepOnce(dshHome);
    if (swept === null) return;   // HMR 重载后的重复调用, 已由 sweepOnce 节流
    const { attachments, screenshots } = swept;
    // 跳过必须显式说出来: 跳过与"扫完了没有孤儿"都表现为 deleted=0, 但前者意味着
    // 证据不足(会话日志读不出来), 是需要有人去看一眼的状态。
    const attachmentPart = attachments.skipped === null
      ? `attachments deleted=${attachments.deleted} keptReferenced=${attachments.keptReferenced} keptRecent=${attachments.keptRecent}`
      : `attachments skipped(${attachments.skipped})`;
    console.log(`[dsh-deveco-tool] sweep: ${attachmentPart}; local screenshots deleted=${screenshots.deleted}`);
  }, 0).unref?.();

  // 插件卸载时清理长驻子进程(对应原 server 的 SIGTERM 清理)。
  ctx.on("dispose", () => {
    shutdownLsp().catch(() => {});
    closeCodeGenie().catch(() => {});
  });
}

export { name, inject, apply };
