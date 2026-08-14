/**
 * @file smoke.test.mjs
 * @author dreamlike
 *
 * 冒烟测试:用假的 Cordis ctx 调用插件入口,验证 29 个工具全部注册成功
 * (模拟 DSH 的 ctx.tools.register 校验路径), 并抽样执行无副作用的工具。
 */
import test from "node:test";
import assert from "node:assert/strict";
import plugin from "./src/plugin.mjs";

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
  plugin(ctx);
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
  plugin(ctx);
  const tool = ctx.registered.find((item) => item.name === "deveco_script_catalog");
  const value = await tool.execute({}, { signal: new AbortController().signal });
  assert.ok(Array.isArray(value.scripts));
  assert.ok(value.scripts.length >= 19);
  assert.equal(value.count, value.scripts.length);
});

test("deveco_status executes", async () => {
  const ctx = makeFakeCtx();
  plugin(ctx);
  const tool = ctx.registered.find((item) => item.name === "deveco_status");
  const value = await tool.execute({}, { signal: new AbortController().signal });
  assert.equal(typeof value.loggedIn, "boolean");
});

test("hdc_log list_devices executes", async () => {
  const ctx = makeFakeCtx();
  plugin(ctx);
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
  plugin(ctx);
  assert.equal(typeof ctx.events.dispose, "function");
});
