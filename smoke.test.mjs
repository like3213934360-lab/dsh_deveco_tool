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
import { resolveSkillsRoot } from "./src/config.mjs";
import { runRegisteredScript, scriptsStatus } from "./src/script-registry.mjs";

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
