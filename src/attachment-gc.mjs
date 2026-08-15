/**
 * @file attachment-gc.mjs
 * @author dreamlike
 *
 * 附件库与本地截图的自动清扫:
 *  - sweepOrphanedAttachments: 删除未被任何会话引用的附件对象。附件是内容寻址
 *    存储(attachments/v1/objects/<前两位>/<sha256>), 引用 = 会话日志 JSONL 里
 *    的 `sha256:<64hex>` 引用; 删除前额外要求对象存在超过 1 小时, 保护写入中
 *    尚未落盘到会话日志的引用。
 *  - sweepLocalScreenshots: 删除本地默认截图目录(os.tmpdir()/deveco-ui/<deviceId>)
 *    中超龄文件; 只处理默认目录, 用户显式指定的 localPath 不受影响。
 *
 * 两者均为启动时一次性尽力清扫(失败不影响插件加载), 与 device-ui 的设备端
 * 陈旧文件清扫(sweepStaleArtifacts)同一模式。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

// 具名导入 zstdDecompressSync 会让整个插件在缺该 API 的 Node 上加载失败:
// ESM 具名导入是静态校验的, 内建模块少一个导出就抛 SyntaxError, 而 plugin.mjs
// 静态 import 本模块。zstdDecompressSync 是 Node 23.8 引入并回移植到 22.x 的,
// 低于此的 Node(package.json 的下限是 20)会直接让插件起不来。改为运行时探测,
// 缺失时放弃清扫而不是让插件失败, 也不是把压缩会话当成"没有引用"。
const zstdDecompressSync = typeof zlib.zstdDecompressSync === "function"
  ? zlib.zstdDecompressSync
  : null;

/** 附件对象文件名: 64 位 sha256 十六进制。 */
const OBJECT_NAME_PATTERN = /^[a-f0-9]{64}$/;
/** 会话日志中的附件引用。 */
const REF_PATTERN = /sha256:([a-f0-9]{64})/g;
/** 清扫阈值: 文件/对象存在超过该时长才允许删除(毫秒)。 */
const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * 读取一个会话日志文件的文本(zstd 或明文)。
 *
 * 抛出而不是返回 null: 调用方必须能区分"这个会话没有引用"和"这个会话读不出来"。
 * 两者在原实现里都表现为引用集里少了条目, 而后果是删掉别人还在用的附件。
 *
 * @param {string} logFile 会话日志文件路径
 * @returns {string} 日志文本
 * @throws {Error} 读取或解压失败, 以及需要 zstd 但当前 Node 不支持
 */
function readSessionLog(logFile) {
  if (logFile.endsWith(".zstd")) {
    if (zstdDecompressSync === null) {
      throw new Error("当前 Node 没有 zlib.zstdDecompressSync(需要 22.15+/23.8+), 无法读取压缩会话日志");
    }
    return zstdDecompressSync(fs.readFileSync(logFile)).toString("utf8");
  }
  return fs.readFileSync(logFile, "utf8");
}

/**
 * 收集 DSH_HOME/sessions 下所有会话日志里出现的附件 sha256 引用。
 *
 * 这份引用集是删除的唯一依据, 所以它必须是完整的或者被明确标记为不完整。
 * 任何一个会话日志读不出来, 就报告 complete:false —— 调用方据此整轮放弃, 因为
 * "扫不到引用"与"确实没有引用"在结果上无法区分, 而按后者行动会删掉别人在用的附件。
 *
 * @param {string} sessionsRoot 会话根目录
 * @returns {{referenced: Set<string>, complete: boolean, reason: string|null}} 引用集与其可信度
 */
function collectReferencedHashes(sessionsRoot) {
  const referenced = new Set();
  let workspaces;
  try {
    workspaces = fs.readdirSync(sessionsRoot);
  } catch (error) {
    return { referenced, complete: false, reason: `无法读取会话目录 ${sessionsRoot}: ${error.message}` };
  }
  for (const workspace of workspaces) {
    const workspaceDir = path.join(sessionsRoot, workspace);
    let sessions;
    try {
      sessions = fs.readdirSync(workspaceDir);
    } catch (error) {
      // ENOTDIR 是正常的: sessions/ 下可能有非目录条目。其余(如 EACCES)意味着
      // 这里可能藏着读不到的引用, 必须让整轮清扫失效。
      if (error.code === "ENOTDIR") continue;
      return { referenced, complete: false, reason: `无法读取 ${workspaceDir}: ${error.message}` };
    }
    for (const session of sessions) {
      const sessionDir = path.join(workspaceDir, session);
      try {
        if (!fs.statSync(sessionDir).isDirectory()) continue;
      } catch (error) {
        return { referenced, complete: false, reason: `无法 stat ${sessionDir}: ${error.message}` };
      }
      // 两个候选都扫: 原实现读到 .zstd 就 break, 一旦某个会话同时留有压缩归档和
      // 未压缩的新片段, 后者里的引用就被漏掉了。
      for (const candidate of ["session.jsonl.zstd", "session.jsonl"]) {
        const logFile = path.join(sessionDir, candidate);
        if (!fs.existsSync(logFile)) continue;
        let text;
        try {
          text = readSessionLog(logFile);
        } catch (error) {
          return { referenced, complete: false, reason: `无法读取会话日志 ${logFile}: ${error.message}` };
        }
        for (const match of text.matchAll(REF_PATTERN)) {
          referenced.add(match[1]);
        }
      }
    }
  }
  return { referenced, complete: true, reason: null };
}

/**
 * 清扫未被任何会话引用、且存在超过 SWEEP_MIN_AGE_MS 的附件对象。
 *
 * 删除的是 DSH 全局附件库, 里面混着其他插件与用户自己的附件, 内容寻址不带来源标记,
 * 无法只挑本插件产生的那些。因此这里对"证据不足"一律不动手, 并可用
 * DEVECO_ATTACHMENT_GC=0 整体关闭。
 *
 * @param {string} dshHome DSH_HOME 根目录
 * @returns {{deleted: number, keptReferenced: number, keptRecent: number, skipped: string|null}} 清扫统计
 */
function sweepOrphanedAttachments(dshHome) {
  const stats = { deleted: 0, keptReferenced: 0, keptRecent: 0, skipped: null };
  if (process.env.DEVECO_ATTACHMENT_GC === "0") {
    stats.skipped = "DEVECO_ATTACHMENT_GC=0";
    return stats;
  }
  const objectsRoot = path.join(dshHome, "attachments", "v1", "objects");
  let buckets;
  try {
    buckets = fs.readdirSync(objectsRoot);
  } catch {
    return stats;
  }
  const { referenced, complete, reason } = collectReferencedHashes(path.join(dshHome, "sessions"));
  if (!complete) {
    // 引用集不完整时删除等于拿别人的数据赌一把, 放弃这一轮才是对的。
    stats.skipped = reason;
    return stats;
  }
  const now = Date.now();
  for (const bucket of buckets) {
    const bucketDir = path.join(objectsRoot, bucket);
    let files;
    try {
      files = fs.readdirSync(bucketDir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!OBJECT_NAME_PATTERN.test(name)) continue;
      if (referenced.has(name)) {
        stats.keptReferenced += 1;
        continue;
      }
      const objectFile = path.join(bucketDir, name);
      let mtimeMs;
      try {
        mtimeMs = fs.statSync(objectFile).mtimeMs;
      } catch {
        continue;
      }
      if (now - mtimeMs < SWEEP_MIN_AGE_MS) {
        stats.keptRecent += 1;
        continue;
      }
      try {
        fs.unlinkSync(objectFile);
        stats.deleted += 1;
      } catch (error) {
        console.warn(`[dsh-deveco-tool] attachment GC unlink failed for ${objectFile}: ${error.message}`);
      }
    }
  }
  return stats;
}

/**
 * 清扫本地默认截图目录(os.tmpdir()/deveco-ui/<deviceId>)中超龄文件。
 * 只处理默认目录; 用户显式指定的 localPath 不受影响。
 * @param {number} maxAgeMs 超过该时长(毫秒)的文件才会被删除, 默认 1 小时
 * @returns {{deleted: number}} 清扫统计
 */
function sweepLocalScreenshots(maxAgeMs = SWEEP_MIN_AGE_MS) {
  const stats = { deleted: 0 };
  const root = path.join(os.tmpdir(), "deveco-ui");
  let devices;
  try {
    devices = fs.readdirSync(root);
  } catch {
    return stats;
  }
  const now = Date.now();
  for (const device of devices) {
    const deviceDir = path.join(root, device);
    let files;
    try {
      files = fs.readdirSync(deviceDir);
    } catch {
      continue;
    }
    for (const name of files) {
      const file = path.join(deviceDir, name);
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (!stat.isFile() || now - stat.mtimeMs < maxAgeMs) continue;
      try {
        fs.unlinkSync(file);
        stats.deleted += 1;
      } catch (error) {
        console.warn(`[dsh-deveco-tool] local screenshot sweep failed for ${file}: ${error.message}`);
      }
    }
  }
  return stats;
}

/**
 * 全进程只清扫一次的标记。
 *
 * 挂在 globalThis 而不是模块级变量: DSH 的 HMR 在插件文件变化时重新 apply, 模块图
 * 也跟着重新求值, 模块级的 once 标记会一并重置, 于是改一次代码就重扫一遍全局附件库。
 * Symbol.for 的键在整个进程里共享, 新旧模块实例看到的是同一个。
 */
const SWEEP_MARKER = Symbol.for("dsh-deveco-tool.attachmentSweepAt");
/** 两次清扫之间的最小间隔; 与附件的年龄门槛同量级, 更频繁也扫不出新东西。 */
const SWEEP_INTERVAL_MS = SWEEP_MIN_AGE_MS;

/**
 * 启动清扫的入口: 同一进程内按 SWEEP_INTERVAL_MS 节流, 避免 HMR 重载反复全库扫描。
 * @param {string} dshHome DSH_HOME 根目录
 * @returns {{attachments: object, screenshots: object}|null} 本次统计; 被节流时为 null
 */
function sweepOnce(dshHome) {
  const last = globalThis[SWEEP_MARKER];
  const now = Date.now();
  if (typeof last === "number" && now - last < SWEEP_INTERVAL_MS) return null;
  globalThis[SWEEP_MARKER] = now;
  return {
    attachments: sweepOrphanedAttachments(dshHome),
    screenshots: sweepLocalScreenshots(),
  };
}

export { sweepLocalScreenshots, sweepOnce, sweepOrphanedAttachments };
