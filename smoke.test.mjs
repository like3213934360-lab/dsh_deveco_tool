/**
 * @file smoke.test.mjs
 * @author dreamlike
 *
 * 冒烟测试:用假的 Cordis ctx 调用插件入口,验证 29 个工具全部注册成功
 * (模拟 DSH 的 ctx.tools.register 校验路径), 并抽样执行无副作用的工具。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { apply } from "./src/plugin.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { resolveDevecoHome, resolveSkillsRoot } from "./src/config.mjs";
import { runRegisteredScript, scriptsStatus } from "./src/script-registry.mjs";
import { sweepOnce, sweepOrphanedAttachments } from "./src/attachment-gc.mjs";

function makeFakeCtx() {
  const registered = [];
  const events = {};
  return {
    registered,
    events,
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    on(event, handler) {
      events[event] = handler;
      return () => {};
    },
  };
}

test("plugin registers all 29 tools", () => {
  const ctx = makeFakeCtx();
  apply(ctx);
  const names = ctx.registered.map((tool) => tool.name);
  assert.equal(names.length, 29);
  const expected = [
    "deveco_script_catalog",
    "deveco_script",
    "switch_cwd",
    "init_project_path",
    "deveco_doctor",
    "deveco_restart",
    "arkts_knowledge_search",
    "deveco_login",
    "deveco_logout",
    "deveco_status",
    "arkts_check",
    "check_ets_files",
    "build_project",
    "start_app",
    "hdc_log",
    "find_references",
    "lsp",
    "go_to_definition",
    "get_hover",
    "list_symbols",
    "find_call_hierarchy",
    "document_validate",
    "ui_snapshot",
    "ui_find",
    "ui_observe",
    "ui_tap",
    "check_cpp_files",
    "perform_ui_action",
    "get_app_ui_tree",
  ];
  assert.deepEqual([...names].sort(), [...expected].sort());
  for (const tool of ctx.registered) {
    assert.ok(tool.description, `${tool.name} must have a description`);
    assert.ok(tool.parameters, `${tool.name} must declare parameters`);
    assert.ok(tool.output?.schema, `${tool.name} must declare output.schema`);
    assert.equal(typeof tool.execute, "function", `${tool.name} must have execute`);
  }
});

test("deveco_script_catalog executes", async () => {
  const ctx = makeFakeCtx();
  apply(ctx);
  const tool = ctx.registered.find((item) => item.name === "deveco_script_catalog");
  const value = await tool.execute({}, { signal: new AbortController().signal });
  assert.ok(Array.isArray(value.scripts));
  assert.ok(value.scripts.length >= 19);
  assert.equal(value.count, value.scripts.length);
});

test("deveco_status executes", async () => {
  const ctx = makeFakeCtx();
  apply(ctx);
  const tool = ctx.registered.find((item) => item.name === "deveco_status");
  const value = await tool.execute({}, { signal: new AbortController().signal });
  assert.equal(typeof value.loggedIn, "boolean");
});

test("hdc_log list_devices executes", async () => {
  const ctx = makeFakeCtx();
  apply(ctx);
  const tool = ctx.registered.find((item) => item.name === "hdc_log");
  const value = await tool.execute(
    { action: "list_devices" },
    { signal: new AbortController().signal },
  );
  assert.equal(value.action, "list_devices");
  assert.ok(Array.isArray(value.devices));
});

test("dispose handler is registered", () => {
  const ctx = makeFakeCtx();
  apply(ctx);
  assert.equal(typeof ctx.events.dispose, "function");
});

// skills 资产随仓库分发, 所以"19 个脚本都在盘上"是可以直接断言的事实, 而不是环境假设。
// 这条守住了回归: 资产漏签出或路径解析改坏, 这里立刻红, 而不是等某次真实调用才发现。
test("bundled skills resolve and every registered script exists", () => {
  const root = resolveSkillsRoot();
  assert.equal(root.source, "repo", "未设 DEVECO_SKILLS_ROOT 时应解析到仓库内 skills/");
  assert.ok(root.path.endsWith("skills"));

  const status = scriptsStatus();
  assert.equal(status.rootExists, true);
  assert.equal(status.total, 19);
  assert.equal(
    status.missing,
    0,
    `缺失脚本: ${status.scripts.filter((s) => !s.exists).map((s) => s.file).join(", ")}`,
  );
});

// 显式配置必须是权威的: 配错时如实报错, 不能静默回落到仓库内那份 —— 否则用户看到一切正常,
// 而跑的是他没打算用的资产。
test("DEVECO_SKILLS_ROOT is authoritative and never silently falls back", () => {
  const previous = process.env.DEVECO_SKILLS_ROOT;
  process.env.DEVECO_SKILLS_ROOT = "/nonexistent/skills-root";
  try {
    const root = resolveSkillsRoot();
    assert.equal(root.source, "environment-missing");
    assert.equal(root.configured, true);
    assert.ok(root.path.includes("nonexistent"), "应保留用户配的路径, 而不是换成仓库内那份");
  } finally {
    if (previous === undefined) delete process.env.DEVECO_SKILLS_ROOT;
    else process.env.DEVECO_SKILLS_ROOT = previous;
  }
});

// 与上一条同一套语义, 但后果更重: hdc、SDK、构建、部署全从 devecoHome 推导, 静默
// 回落意味着用户以为在对 A 操作而实际打到了 B。
test("DEVECO_HOME is authoritative and never silently falls back", () => {
  const previousHome = process.env.DEVECO_HOME;
  const previousPath = process.env.DEVECO_PATH;
  process.env.DEVECO_HOME = "/nonexistent-deveco-home";
  delete process.env.DEVECO_PATH;
  try {
    const home = resolveDevecoHome();
    assert.equal(home.source, "environment-missing");
    assert.equal(home.configured, true);
    assert.ok(
      home.path.includes("nonexistent-deveco-home"),
      "必须保留用户配的路径, 而不是换成平台默认目录还自称 environment",
    );
  } finally {
    if (previousHome === undefined) delete process.env.DEVECO_HOME;
    else process.env.DEVECO_HOME = previousHome;
    if (previousPath !== undefined) process.env.DEVECO_PATH = previousPath;
  }
});

test("deveco_script_catalog reports skills availability", async () => {
  const ctx = makeFakeCtx();
  apply(ctx);
  const tool = ctx.registered.find((item) => item.name === "deveco_script_catalog");
  const value = await tool.execute({}, { signal: new AbortController().signal });
  assert.equal(value.skillsRootExists, true);
  assert.equal(value.missing, 0);
  assert.ok(value.scripts.every((script) => script.exists === true));
});

test("unknown script id is rejected before any spawn", async () => {
  await assert.rejects(
    () => runRegisteredScript("no_such_script", {}),
    (error) => error.code === "UNKNOWN_SCRIPT",
  );
});

// 附件 GC 删的是 DSH 全局附件库(内容寻址, 不带来源标记, 混着其他插件和用户自己的
// 附件), 唯一的护栏就是引用集是否可信。这三条把该护栏钉死: 证据不足不动手、
// 证据完整才删孤儿、压缩会话里的引用同样算引用。
function makeGcFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deveco-gc-"));
  const stale = new Date("2020-01-01T00:00:00Z");
  const writeObject = (hash, body) => {
    const dir = path.join(root, "attachments", "v1", "objects", hash.slice(0, 2));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, hash);
    fs.writeFileSync(file, body);
    fs.utimesSync(file, stale, stale);   // 跨过 1 小时的年龄门槛
    return file;
  };
  return { root, writeObject, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

test("attachment GC refuses to delete when the reference set is incomplete", () => {
  const fixture = makeGcFixture();
  try {
    const object = fixture.writeObject(HASH_A, "orphan");
    // sessions/ 不存在 => 读不到任何引用。原实现会把这当成"没有引用"并删光。
    const stats = sweepOrphanedAttachments(fixture.root);
    assert.equal(stats.deleted, 0);
    assert.ok(stats.skipped, "证据不足时必须报告 skipped 而不是静默删除");
    assert.ok(fs.existsSync(object), "证据不足时附件必须原样保留");
  } finally {
    fixture.cleanup();
  }
});

test("attachment GC deletes orphans once the reference set is complete", () => {
  const fixture = makeGcFixture();
  try {
    const object = fixture.writeObject(HASH_A, "orphan");
    const sessionDir = path.join(fixture.root, "sessions", "ws", "session-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, "session.jsonl"), '{"role":"user"}\n');
    const stats = sweepOrphanedAttachments(fixture.root);
    assert.equal(stats.skipped, null);
    assert.equal(stats.deleted, 1);
    assert.equal(fs.existsSync(object), false);
  } finally {
    fixture.cleanup();
  }
});

// DSH 的 HMR 每次改动都重新 apply 插件, 模块图也重新求值。清扫要按进程节流, 否则
// 改一行代码就重扫一遍全局附件库。标记挂在 globalThis 上正是为了跨模块重载存活。
test("startup sweep is throttled across HMR reloads", () => {
  const marker = Symbol.for("dsh-deveco-tool.attachmentSweepAt");
  const previous = globalThis[marker];
  const fixture = makeGcFixture();
  try {
    delete globalThis[marker];
    assert.notEqual(sweepOnce(fixture.root), null, "首次必须真的执行");
    assert.equal(sweepOnce(fixture.root), null, "同进程内的后续调用必须被节流");
  } finally {
    fixture.cleanup();
    if (previous === undefined) delete globalThis[marker];
    else globalThis[marker] = previous;
  }
});

test("attachment GC honours references inside zstd session logs", (t) => {
  if (typeof zlib.zstdDecompressSync !== "function") {
    t.skip("当前 Node 无 zstd 支持");
    return;
  }
  const fixture = makeGcFixture();
  try {
    const referenced = fixture.writeObject(HASH_B, "referenced");
    const sessionDir = path.join(fixture.root, "sessions", "ws", "session-1");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "session.jsonl.zstd"),
      zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ img: `sha256:${HASH_B}` })}\n`)),
    );
    const stats = sweepOrphanedAttachments(fixture.root);
    assert.equal(stats.skipped, null);
    assert.equal(stats.keptReferenced, 1);
    assert.equal(stats.deleted, 0);
    assert.ok(fs.existsSync(referenced));
  } finally {
    fixture.cleanup();
  }
});
