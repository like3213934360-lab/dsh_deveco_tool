import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(sourceDir, "..");

function existingDirectory(candidate) {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析 skills 资产根目录。
 *
 * 19 个注册脚本连同它们的知识库都随仓库分发在 skills/ 下, 所以默认情况下无需任何配置。
 * DEVECO_SKILLS_ROOT 仅用于覆盖 —— 指向仓库外另一份资产。与 resolveDevecoHome 一致,
 * 显式配置优先于探测; 显式配置指向的目录不存在时仍返回该路径并标记 environment-missing,
 * 让报错指向用户真正配的位置, 而不是静默回落到仓库内那份, 掩盖配错的事实。
 *
 * @returns {{path: string, source: string, configured: boolean}} 解析结果; 候选都不存在
 *   且未配置环境变量时 path 为空字符串, 调用方必须显式处理而不能当相对路径拼接。
 */
export function resolveSkillsRoot() {
  const configured = process.env.DEVECO_SKILLS_ROOT;
  if (configured) {
    const absolute = path.resolve(configured);
    return {
      path: absolute,
      source: existingDirectory(absolute) ? "environment" : "environment-missing",
      configured: true,
    };
  }

  const bundled = path.join(REPO_ROOT, "skills");
  if (existingDirectory(bundled)) {
    return { path: bundled, source: "repo", configured: false };
  }

  return { path: "", source: "not-found", configured: false };
}

// 加载期解析一次: script-registry 的路径拼接和 tools-defs 的 enum 构建都发生在加载期。
// 空字符串表示没有任何候选可用 —— scriptPath() 必须挡住它。
export const SKILLS_ROOT = resolveSkillsRoot().path;

/**
 * 当前平台上 DevEco Studio 的默认安装位置。
 *
 * 按平台分支而不是把三个平台的路径堆在一起: 探测的只是目录是否存在, 混在一起也能跑,
 * 但 source 就说不清命中的是哪一类默认值了, 而 doctor 要靠它告诉用户"这是猜的还是你
 * 配的"。三处都只列官方安装器的默认目标, 装到别处的用 DEVECO_HOME 覆盖。
 *
 * @returns {string[]} 候选目录, 按优先级排列。
 */
function defaultDevecoHomes() {
  if (process.platform === "darwin") {
    return ["/Applications/DevEco-Studio.app/Contents", "/Applications/DevEco-Studio.app"];
  }
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    return [
      path.join(programFiles, "Huawei", "DevEco Studio"),
      path.join(programFiles, "Huawei", "DevEcoStudio"),
    ];
  }
  return [
    "/opt/deveco-studio",
    "/usr/local/deveco-studio",
    path.join(os.homedir(), "deveco-studio"),
  ];
}

/**
 * 归一化一个 DevEco 安装路径。
 * @param {string} candidate 候选路径。
 * @returns {string} 绝对路径; macOS 的 .app 包指向其 Contents, SDK 与工具链都在那下面。
 */
function normalizeDevecoPath(candidate) {
  const absolute = path.resolve(candidate);
  return absolute.endsWith(".app") ? path.join(absolute, "Contents") : absolute;
}

/**
 * 解析 DevEco Studio 安装目录。
 *
 * 显式配置是权威的, 与 resolveSkillsRoot 同一套语义: 配了 DEVECO_HOME 却指向无效目录
 * 时如实报 environment-missing, 而不是回落到平台默认路径。回落在这里格外危险 —— hdc、
 * SDK、构建与部署全都从这个路径推导, 用户以为在对 A 操作, 实际打到了 B, 而原实现连
 * source 都照报 "environment", 等于把这个偏差藏了起来。
 *
 * @returns {{path: string, source: string, configured: boolean}} 解析结果。
 */
export function resolveDevecoHome() {
  const configured = process.env.DEVECO_HOME || process.env.DEVECO_PATH;
  if (configured) {
    const normalized = normalizeDevecoPath(configured);
    return {
      path: normalized,
      source: existingDirectory(normalized) ? "environment" : "environment-missing",
      configured: true,
    };
  }

  for (const candidate of defaultDevecoHomes()) {
    const normalized = normalizeDevecoPath(candidate);
    if (existingDirectory(normalized)) {
      return { path: normalized, source: `${process.platform}-default`, configured: false };
    }
  }

  return { path: "", source: "not-found", configured: false };
}

export function resolveHdcPath() {
  const explicit = process.env.HDC_PATH;
  if (explicit && fs.existsSync(explicit)) {
    return path.resolve(explicit);
  }

  const deveco = resolveDevecoHome();
  if (deveco.path) {
    const candidates = [
      path.join(deveco.path, "sdk", "default", "openharmony", "toolchains", "hdc"),
      path.join(deveco.path, "sdk", "default", "openharmony", "toolchains", "hdc.exe"),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (found) return found;
  }

  return explicit || "hdc";
}

export function collectEnvironmentStatus() {
  const deveco = resolveDevecoHome();
  const hdc = resolveHdcPath();
  // 实时解析而非复用加载期的 SKILLS_ROOT: doctor 存在的意义就是报告此刻的真实情况。
  const skills = resolveSkillsRoot();
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    repoRoot: REPO_ROOT,
    skillsRoot: skills.path || null,
    skillsRootSource: skills.source,
    // 之前这里直出常量, 目录不存在也照报, 于是 doctor 看着正常而每个脚本都跑不起来。
    skillsRootExists: Boolean(skills.path) && existingDirectory(skills.path),
    devecoHome: deveco.path || null,
    devecoHomeSource: deveco.source,
    hdcPath: hdc,
    hdcExists: hdc !== "hdc" && fs.existsSync(hdc),
  };
}
