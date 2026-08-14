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
import { zstdDecompressSync } from "node:zlib";

/** 附件对象文件名: 64 位 sha256 十六进制。 */
const OBJECT_NAME_PATTERN = /^[a-f0-9]{64}$/;
/** 会话日志中的附件引用。 */
const REF_PATTERN = /sha256:([a-f0-9]{64})/g;
/** 清扫阈值: 文件/对象存在超过该时长才允许删除(毫秒)。 */
const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * 读取一个会话日志文件的文本(zstd 或明文),失败返回 null。
 * @param {string} logFile 会话日志文件路径
 * @returns {string|null} 日志文本,读取/解压失败时为 null
 */
function readSessionLog(logFile) {
  try {
    if (logFile.endsWith(".zstd")) {
      return zstdDecompressSync(fs.readFileSync(logFile)).toString("utf8");
    }
    return fs.readFileSync(logFile, "utf8");
  } catch (error) {
    console.warn(`[dsh-deveco-tool] attachment GC: cannot read session log ${logFile}: ${error.message}`);
    return null;
  }
}

/**
 * 收集 DSH_HOME/sessions 下所有会话日志里出现的附件 sha256 引用。
 * @param {string} sessionsRoot 会话根目录
 * @returns {Set<string>} 被引用的 sha256 集合
 */
function collectReferencedHashes(sessionsRoot) {
  const referenced = new Set();
  let workspaces;
  try {
    workspaces = fs.readdirSync(sessionsRoot);
  } catch {
    return referenced;
  }
  for (const workspace of workspaces) {
    const workspaceDir = path.join(sessionsRoot, workspace);
    let sessions;
    try {
      sessions = fs.readdirSync(workspaceDir);
    } catch {
      continue;
    }
    for (const session of sessions) {
      const sessionDir = path.join(workspaceDir, session);
      try {
        if (!fs.statSync(sessionDir).isDirectory()) continue;
      } catch {
        continue;
      }
      for (const candidate of ["session.jsonl.zstd", "session.jsonl"]) {
        const logFile = path.join(sessionDir, candidate);
        if (!fs.existsSync(logFile)) continue;
        const text = readSessionLog(logFile);
        if (text === null) continue;
        for (const match of text.matchAll(REF_PATTERN)) {
          referenced.add(match[1]);
        }
        break;
      }
    }
  }
  return referenced;
}

/**
 * 清扫未被任何会话引用、且存在超过 SWEEP_MIN_AGE_MS 的附件对象。
 * @param {string} dshHome DSH_HOME 根目录
 * @returns {{deleted: number, keptReferenced: number, keptRecent: number}} 清扫统计
 */
function sweepOrphanedAttachments(dshHome) {
  const stats = { deleted: 0, keptReferenced: 0, keptRecent: 0 };
  const objectsRoot = path.join(dshHome, "attachments", "v1", "objects");
  let buckets;
  try {
    buckets = fs.readdirSync(objectsRoot);
  } catch {
    return stats;
  }
  const referenced = collectReferencedHashes(path.join(dshHome, "sessions"));
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

export { sweepLocalScreenshots, sweepOrphanedAttachments };
