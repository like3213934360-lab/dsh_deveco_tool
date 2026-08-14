/**
 * @file plugin.mjs
 * @author dreamlike
 *
 * DSH 原生插件入口:把 deveco_tool 的 29 个工具注册为 DSH 工具。
 * 业务模块提取自 /Users/dreamlike/DreamLike/deveco_tool(原项目未改动),
 * 工具 schema 表逐字来自 tools-defs.mjs(提取自原 server.mjs 的 localTools)。
 */

import { listScripts, runRegisteredScript } from "./script-registry.mjs";
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
 * @param textOnly 结果为纯文本字符串(如构建日志)时输出声明为 string
 * @returns 工具定义对象
 */
function defineTool(name, description, parameters, execute, textOnly = false) {
  return {
    name,
    description,
    parameters,
    output: textOnly
      ? {
          schema: { type: "string" },
          render: (_args, value) => [{ type: "text", text: value }],
        }
      : {
          schema: { type: "object", additionalProperties: true },
          render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
        },
    execute,
  };
}

/**
 * 按工具名分发执行,逻辑逐条对应原 server.mjs 的 callTool 分支。
 *
 * @param name 工具名
 * @param args 参数对象
 * @returns 规范 JSON 值或字符串
 */
async function dispatch(name, args) {
  switch (name) {
    case "deveco_script_catalog": {
      const scripts = listScripts();
      return { scripts, count: scripts.length };
    }
    case "deveco_script": {
      if (typeof args.script !== "string") {
        fail("script is required", "SCRIPT_REQUIRED");
      }
      const result = await runRegisteredScript(args.script, args);
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
      return { question: args.question, answer: await searchKnowledge(args.question) };
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
      return runArktsCheck(args);
    case "check_ets_files":
      if (!Array.isArray(args.files)) {
        fail("files must be an array of .ets or .ts paths", "ARKTS_FILES_INVALID");
      }
      return runArktsCheck({ files: args.files });
    case "build_project":
      return buildProject(args);
    case "start_app":
      return startApp(args);
    case "hdc_log":
      return hdcLog(args);
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
      return uiSnapshot(args);
    case "ui_observe":
      return uiObserve(args);
    case "ui_find":
      return uiFind(args);
    case "ui_tap":
      return uiTap(args);
    default:
      fail(`Unknown tool: ${name}`, "UNKNOWN_TOOL");
  }
}

/**
 * DSH 插件入口:注册 26 个本地工具 + 3 个 CodeGenie 代理工具。
 *
 * @param ctx Cordis 上下文(tools 服务来自 dsh-tools)
 */
export default function dshDevecoToolPlugin(ctx) {
  const textOnlyTools = new Set(["build_project", "start_app"]);

  for (const tool of localTools) {
    ctx.tools.register(defineTool(
      tool.name,
      tool.description,
      tool.inputSchema,
      async (args, exec) => dispatch(tool.name, args),
      textOnlyTools.has(tool.name),
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
          return callCodeGenieTool(tool.name, { ...args, hvd: devices[0] });
        }
        return callCodeGenieTool(tool.name, args);
      },
    ));
  }

  // 插件卸载时清理长驻子进程(对应原 server 的 SIGTERM 清理)。
  ctx.on("dispose", () => {
    shutdownLsp().catch(() => {});
    closeCodeGenie().catch(() => {});
  });
}
