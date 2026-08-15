import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT, SKILLS_ROOT, resolveDevecoHome, resolveSkillsRoot } from "./config.mjs";
import { getProjectPath } from "./project-context.mjs";
// Shared with the DevEco CLI runner; see that module for why the hvigor daemon stays out of reach.
import { terminateProcessTree } from "./process-tree.mjs";


const SCRIPT_DEFINITIONS = {
  copy_template: {
    skill: "deveco-create-project",
    file: "scripts/copy-template.mjs",
    description: "Copy the bundled ArkTS project template and resolve its SDK metadata.",
  },
  detect_sdk: {
    skill: "deveco-create-project",
    file: "scripts/detect-sdk.mjs",
    description: "Detect the API level and SDK metadata from the configured DevEco Studio.",
  },
  collect_hilog: {
    skill: "arkts-runtime-fix",
    file: "scripts/collect-hilog.mjs",
    description: "Collect a bounded HILOG snapshot from a connected HarmonyOS device.",
  },
  fetch_faultlog: {
    skill: "arkts-runtime-fix",
    file: "scripts/fetch-faultlog.mjs",
    description: "Fetch a named faultlogger file from a connected HarmonyOS device.",
  },
  jscrash_report: {
    skill: "arkts-runtime-fix",
    file: "scripts/jscrash-report.mjs",
    description: "Collect or analyze a JS crash report and produce structured diagnostics.",
  },
  parse_jscrash_log: {
    skill: "arkts-runtime-fix",
    file: "scripts/parse-jscrash-log.mjs",
    description: "Parse a JS crash log from a file or inline text.",
  },
  probe_faultlogger: {
    skill: "arkts-runtime-fix",
    file: "scripts/probe-faultlogger.mjs",
    description: "Probe recent faultlogger entries on a connected HarmonyOS device.",
  },
  search_practices: {
    skill: "arkui-component-best-practices",
    file: "scripts/search-practices.mjs",
    description: "Search the ArkUI component practice library by component name or keyword. "
      + "Takes a positional query and --limit=N / --json, so pass argv (e.g. [\"Swiper\", \"--limit=5\", \"--json\"]); "
      + "the args object form cannot express a positional query.",
  },
  ui_score: {
    skill: "ui-reconstruction-score",
    runtime: "python",
    description: "Score UI reconstruction fidelity between a reference and a candidate screenshot (or "
      + "two directories). Takes two positional paths, so pass argv (e.g. [\"ref.png\", \"cand.png\", "
      + "\"--out\", \"report\", \"--ignore-top-px\", \"44\"]). Needs Pillow; check deveco_doctor first.",
    file: "scripts/ui_score.py",
  },
  apifault_collect_hilog: {
    skill: "hmos-apifault-analysis",
    runtime: "python",
    file: "references/scripts/hilog_collector.py",
    description: "Collect and filter device hilog for API fault analysis.",
  },
  apifault_analyze_media: {
    skill: "hmos-apifault-analysis",
    runtime: "python",
    file: "references/scripts/media_file_analyzer.py",
    description: "Inspect a media file's container and codec metadata when diagnosing a media API fault.",
  },
  appfreeze_analyze: {
    skill: "hmos-appfreeze-analysis",
    runtime: "python",
    file: "scripts/freeze/main.py",
    description: "Analyze an appfreeze fault log: binder chains, stack sections, and a structured report.",
  },
  appfreeze_sample_stack: {
    skill: "hmos-appfreeze-analysis",
    runtime: "python",
    file: "scripts/sample_stack_analyzer.py",
    description: "Analyze a sampled stack trace collected during an appfreeze.",
  },
  arkts_docs_search: {
    skill: "hmos-arkts-knowledge-retriever",
    runtime: "python",
    file: "scripts/search_docs.py",
    description: "Search the bundled ArkTS documentation index shipped with this skill.",
  },
  arkui_docs_search: {
    skill: "hmos-arkui-knowledge-retriever",
    runtime: "python",
    file: "scripts/run.py",
    description: "Query the bundled ArkUI knowledge base for API usage, parameters, and version support.",
  },
  arkui_docs_rebuild_index: {
    skill: "hmos-arkui-knowledge-retriever",
    runtime: "python",
    file: "scripts/rebuild_index.py",
    description: "Rebuild the ArkUI knowledge base index after its documents change.",
  },
  instrument_test_run: {
    skill: "hmos-instrument-test",
    runtime: "python",
    file: "scripts/run_instrument_test.py",
    description: "Run instrumented (on-device) tests for a HarmonyOS module and report the results.",
  },
  local_test_run: {
    skill: "hmos-local-test",
    runtime: "python",
    file: "scripts/run_local_test.py",
    description: "Run local (host-side) unit tests for a HarmonyOS module and report the results.",
  },
  memleak_analyze: {
    skill: "hmos-memleak-analysis",
    runtime: "python",
    file: "scripts/skill_main.py",
    description: "Analyze an ArkTS heap snapshot for leak suspects and risky retain paths.",
  },
};

/**
 * Locate a Python interpreter for `runtime: "python"` scripts.
 * An explicit PYTHON is authoritative: if it is set but unusable, report that rather than silently
 * falling back to a different interpreter, which is how a script ends up running without Pillow.
 * @returns {string|null} The interpreter command, or null when none is usable.
 */
export function resolvePython() {
  const explicit = process.env.PYTHON;
  const candidates = explicit ? [explicit] : ["python3", "python"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

/**
 * Report whether Pillow is importable by the resolved interpreter.
 * ui_score.py is the only script with a third-party dependency, and the system python3 on macOS
 * usually does not have it, so this has to be checked rather than assumed.
 * @returns {{available: boolean, python: string|null, version: string|null, pillow: boolean}} Status.
 */
export function pythonStatus() {
  const python = resolvePython();
  if (!python) return { available: false, python: null, version: null, pillow: false };
  const version = spawnSync(python, ["--version"], { encoding: "utf8" });
  const pillow = spawnSync(python, ["-c", "import PIL"], { stdio: "ignore" });
  return {
    available: true,
    python,
    version: (version.stdout || version.stderr || "").trim() || null,
    pillow: !pillow.error && pillow.status === 0,
  };
}

/**
 * 脚本的绝对路径, skills 根不可用时为 null。
 * 返回 null 而不是拼接: SKILLS_ROOT 为空时 path.join("", skill, file) 会得到一个相对路径,
 * spawn 会拿它相对 cwd 去找, 于是错误从"资产没配好"变成"某个项目目录里缺文件"。
 * @param {{skill: string, file: string}} definition 脚本定义。
 * @returns {string|null} 绝对路径, 或 null 表示 skills 根未解析出来。
 */
function scriptPath(definition) {
  if (!SKILLS_ROOT) return null;
  return path.join(SKILLS_ROOT, definition.skill, definition.file);
}

/**
 * 相对 skills 根的展示路径, 不经过 SKILLS_ROOT, 因此资产缺失时依然完整。
 * @param {{skill: string, file: string}} definition 脚本定义。
 * @returns {string} 形如 `skills/<skill>/<file>` 的相对路径。
 */
function displayPath(definition) {
  return path.join("skills", definition.skill, definition.file);
}

// 必须保持无 IO: tools-defs 在模块加载期用它构建 deveco_script 的 enum, 而工具签名不能
// 因为某个脚本文件缺失就变形 —— 落盘状态是诊断信息, 归 scriptsStatus()。
export function listScripts() {
  return Object.entries(SCRIPT_DEFINITIONS).map(([id, definition]) => ({
    id,
    skill: definition.skill,
    file: displayPath(definition),
    runtime: definition.runtime ?? "node",
    description: definition.description,
  }));
}

/**
 * listScripts() 加上每个脚本此刻是否真的在盘上, 以及 skills 根的解析来源。
 * 注册表是静态的, 所以光看脚本列表分不出"已装好"和"根本找不到资产", 这一层就是补这个差。
 * @returns {{root: string|null, rootSource: string, rootExists: boolean, total: number,
 *   missing: number, scripts: Array<object>}} 诊断视图。
 */
export function scriptsStatus() {
  const root = resolveSkillsRoot();
  const rootExists = Boolean(root.path) && fs.existsSync(root.path);
  const scripts = Object.entries(SCRIPT_DEFINITIONS).map(([id, definition]) => {
    const absolute = scriptPath(definition);
    return {
      id,
      skill: definition.skill,
      file: displayPath(definition),
      runtime: definition.runtime ?? "node",
      description: definition.description,
      exists: absolute !== null && fs.existsSync(absolute),
    };
  });
  return {
    root: root.path || null,
    rootSource: root.source,
    rootExists,
    total: scripts.length,
    missing: scripts.filter((script) => !script.exists).length,
    scripts,
  };
}

function kebabCase(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/_/g, "-");
}

function objectToArgv(args) {
  const argv = [];
  for (const [key, value] of Object.entries(args ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    const flag = `--${kebabCase(key)}`;
    if (value === true) {
      argv.push(flag);
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) argv.push(flag, String(item));
      continue;
    }
    argv.push(flag, String(value));
  }
  return argv;
}

// Skill scripts print a `key: value` block and then free-form narrative: stack
// frames, hilog excerpts, evidence dumps. Treating every `x: y` line as a field
// turned that narrative into fabricated keys ("08-02 14", "at foo (Bar.ets"),
// and a later duplicate could overwrite a real value. Every field the scripts
// actually emit is lowercase snake_case, so that is the accepted key shape.
const SCRIPT_FIELD_KEY = /^[a-z][a-z0-9_]*$/;

// Exported so the key-filtering rules can be unit tested without spawning a script.
export function parseScriptOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const values = {};
    let found = false;
    for (const line of trimmed.split(/\r?\n/)) {
      const equals = line.indexOf("=");
      const colon = line.indexOf(":");
      const separator = equals >= 0 ? equals : colon;
      if (separator <= 0) continue;
      const key = line.slice(0, separator).trim();
      if (!SCRIPT_FIELD_KEY.test(key)) continue;
      if (Object.hasOwn(values, key)) continue;
      values[key] = line.slice(separator + 1).trim();
      found = true;
    }
    return found ? values : null;
  }
}

export async function runRegisteredScript(id, input = {}) {
  const definition = SCRIPT_DEFINITIONS[id];
  if (!definition) {
    const error = new Error(`Unknown registered script: ${id}`);
    error.code = "UNKNOWN_SCRIPT";
    throw error;
  }

  // "整个根没找到"和"这一个脚本缺了"是两种故障: 前者说明仓库的 skills/ 没跟着签出(或
  // DEVECO_SKILLS_ROOT 配错), 后者说明资产在但不完整。混成一条会把人引向错的方向。
  const skillsHint = `确认仓库的 ${path.join(REPO_ROOT, "skills")} 存在, 或用 DEVECO_SKILLS_ROOT 指向另一份资产。`
    + "deveco_doctor 的 environment.skillsRoot / scripts 会报告当前解析结果。";
  const file = scriptPath(definition);
  if (file === null) {
    const error = new Error("skills 资产目录未找到, 无法定位任何注册脚本。");
    error.code = "SKILLS_ROOT_NOT_FOUND";
    error.hint = skillsHint;
    throw error;
  }
  if (!fs.existsSync(file)) {
    const root = resolveSkillsRoot();
    const error = new Error(`Registered script is missing: ${file}`);
    error.code = "SCRIPT_NOT_FOUND";
    error.hint = root.source === "environment-missing"
      ? `DEVECO_SKILLS_ROOT 指向的 ${root.path} 不是一个存在的目录。`
      : skillsHint;
    throw error;
  }

  const rawArgs = input.args ?? Object.fromEntries(
    Object.entries(input).filter(([key]) => !["script", "argv", "timeoutMs"].includes(key)),
  );
  const argv = Array.isArray(input.argv)
    ? input.argv.map(String)
    : objectToArgv(rawArgs);
  const timeoutMs = Math.min(Math.max(Number(input.timeoutMs ?? 120000), 1000), 600000);
  const devecoHome = resolveDevecoHome().path;
  const childEnv = { ...process.env };
  if (devecoHome) childEnv.DEVECO_HOME = devecoHome;

  const runtime = definition.runtime ?? "node";
  let command = process.execPath;
  if (runtime === "python") {
    const python = resolvePython();
    if (!python) {
      const error = new Error(`${id} needs a Python interpreter and none was usable.`);
      error.code = "PYTHON_NOT_FOUND";
      error.hint = process.env.PYTHON
        ? `PYTHON is set to "${process.env.PYTHON}" but it did not run. Point it at a working interpreter or unset it.`
        : "安装 Python 3,或把 PYTHON 环境变量指向可用的解释器。ui_score 还额外需要 Pillow。";
      throw error;
    }
    command = python;
  }

  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, [file, ...argv], {
      cwd: getProjectPath() ?? REPO_ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      // Own process group. Several registered scripts shell out to hvigor, ohpm or hdc, and
      // signalling only the direct child left those grandchildren running: hvigor daemons and
      // Python workers survived every timeout and accumulated across a session.
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    // Caller cancellation kills the whole group, same as a timeout.
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      terminateProcessTree(child);
      resolve({ exitCode: null, signal: "SIGTERM", stdout, stderr });
    };
    if (input.signal) {
      if (input.signal.aborted) onAbort();
      else input.signal.addEventListener("abort", onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      terminateProcessTree(child);
      if (!settled) {
        settled = true;
        const error = new Error(`Script timed out after ${timeoutMs}ms: ${id}`);
        error.code = "SCRIPT_TIMEOUT";
        reject(error);
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, stdout, stderr });
    });
  });

  // A zero exit with nothing on stdout means the script produced no result at
  // all; say so rather than letting an empty `parsed` read as a clean run.
  const silentSuccess = result.exitCode === 0 && !result.stdout.trim();

  return {
    script: id,
    skill: definition.skill,
    file: path.relative(REPO_ROOT, file),
    runtime,
    argv,
    cwd: getProjectPath() ?? REPO_ROOT,
    exitCode: result.exitCode,
    signal: result.signal,
    ok: result.exitCode === 0,
    parsed: parseScriptOutput(result.stdout),
    ...(silentSuccess ? { warning: "Script exited 0 without writing to stdout; it produced no result." } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
