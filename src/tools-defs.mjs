/**
 * @file tools-defs.mjs
 * 工具 schema 定义表, 逐字提取自 deveco_tool/src/server.mjs 的 localTools 数组
 * (提取时原项目未改动)。execute 逻辑在 plugin.mjs 中按 name 分发。
 */
import { listScripts } from "./script-registry.mjs";

const scriptIds = listScripts().map((script) => script.id);

export const localTools = [
  {
    name: "deveco_script_catalog",
    description: "List the allowlisted DevEco skill scripts that can be executed through this unified MCP.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "deveco_script",
    description: "Run one allowlisted DevEco skill script. Use args for named values or argv for exact script arguments.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", enum: scriptIds },
        args: { type: "object", additionalProperties: true },
        argv: { type: "array", items: { type: "string" } },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      required: ["script"],
      additionalProperties: false,
    },
  },
  {
    name: "switch_cwd",
    description: "Set the active HarmonyOS project root for subsequent script calls.",
    inputSchema: {
      type: "object",
      properties: { project_path: { type: "string" } },
      required: ["project_path"],
      additionalProperties: false,
    },
  },
  {
    name: "init_project_path",
    description: "Compatibility alias for switch_cwd; set the active HarmonyOS project root.",
    inputSchema: {
      type: "object",
      properties: { project_path: { type: "string" } },
      required: ["project_path"],
      additionalProperties: false,
    },
  },
  {
    name: "deveco_doctor",
    description: "Inspect local DevEco, HDC, project-context, and extracted Skill availability.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "deveco_restart",
    description:
      "Restart this server's long-lived children in place, without dropping the client connection. "
      + "Use to recover from a stuck or erroring language service after fixing the root cause, instead of "
      + "restarting the whole agent session. `arkts` resets the ArkTS language server (affects lsp and its "
      + "five aliases). `cpp` drops the CodeGenie child, which also backs get_app_ui_tree and "
      + "perform_ui_action, so those reconnect on their next call too. `all` (default) does both. Nothing is "
      + "respawned eagerly: the next call that needs a child starts it. Caution: if the service fails again "
      + "right after a restart, the cause is a persistent project or SDK configuration problem -- do not call "
      + "this repeatedly, run deveco_doctor and fix the project first.",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string", enum: ["arkts", "cpp", "all"] } },
      additionalProperties: false,
    },
  },
  {
    name: "arkts_knowledge_search",
    description: "Search the official DevEco CodeGenie ArkTS, ArkUI, HarmonyOS, and OpenHarmony knowledge base.",
    inputSchema: {
      type: "object",
      properties: { question: { type: "string", minLength: 1 } },
      required: ["question"],
      additionalProperties: false,
    },
  },
  {
    name: "deveco_login",
    description: "Open the China-site Huawei DevEco login page and persist the local session token.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "deveco_logout",
    description: "Clear the local DevEco login session.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "deveco_status",
    description: "Return DevEco login state without exposing access or refresh tokens.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "arkts_check",
    description: "Run the official DevEco ArkTS static checker against the selected project or explicit .ets files.",
    inputSchema: {
      type: "object",
      properties: {
        files: { type: "array", items: { type: "string" }, description: "Optional project-relative or absolute .ets paths; omit to scan the project." },
        project_path: { type: "string", description: "Optional project root; otherwise use the active project from switch_cwd." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "check_ets_files",
    description: "Run the official local DevEco ArkTS checker for the requested .ets or .ts files.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Project-relative or absolute .ets/.ts file paths.",
        },
      },
      required: ["files"],
      additionalProperties: false,
    },
  },
  {
    name: "build_project",
    description: "Build a HarmonyOS project or specific modules through the bundled DevEco CLI. "
      + "Omit modules to build the whole product. Set clean only when a full rebuild is explicitly wanted: "
      + "it cleans and then builds, which discards incremental caches and makes the build much slower.",
    inputSchema: {
      type: "object",
      properties: {
        modules: {
          type: "array",
          items: { type: "string" },
          description: "Modules to build, as `module` or `module@target` (e.g. entry, app_platform@default).",
        },
        module: { type: "string", description: "Single module, kept for compatibility; merged into modules." },
        product: { type: "string", description: "Product name from build-profile.json5; defaults to `default`." },
        build_mode: { type: "string", description: "Build mode from buildModeSet (e.g. debug, release); defaults to debug." },
        clean: { type: "boolean", description: "Clean build outputs first, then build." },
        log_path: { type: "string", description: "Write the full build log here; the reply then keeps only the last 50 lines." },
        enable_inspector_source_jump: {
          type: "boolean",
          description: "Accepted for compatibility only. The DevEco CLI has no equivalent, so this is reported as not applied rather than silently ignored.",
        },
        project_path: { type: "string", description: "Optional project root; otherwise the active project from switch_cwd." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 3600000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "start_app",
    description: "Deploy the already-built app to a connected device and launch it through the bundled DevEco CLI. "
      + "Does not build. Resolves the device automatically when exactly one is connected.",
    inputSchema: {
      type: "object",
      properties: {
        hvd: { type: "string", description: "Target device name or serial; resolved automatically when omitted." },
        module: { type: "string", description: "Module to launch (e.g. entry, phone)." },
        target: { type: "string", description: "Build target; combined with module as module@target." },
        ability: { type: "string", description: "Ability to launch; read from module.json5 when omitted." },
        project_path: { type: "string", description: "Optional project root; otherwise the active project from switch_cwd." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 3600000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "hdc_log",
    description: "List connected HarmonyOS devices, collect filtered hilog lines, or clear the device log buffer. Collect pushes the filter down to hilog itself, so narrowing log_prefix or lines cuts what crosses the wire rather than only what is printed.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["collect", "clear", "list_devices"] },
        device_id: { type: "string", description: "Required when more than one device is connected; hdc_log list_devices prints the keys." },
        log_prefix: { type: "string", description: "Collect only lines containing this prefix; defaults to [VCODER_DEBUG]. Matched literally, and matched on the device." },
        lines: { type: "integer", minimum: 1, maximum: 5000 },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000, description: "Deadline for the collect. On expiry the lines already read are returned with truncated: true rather than discarded." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  {
    name: "find_references",
    description: "Find all ArkTS/TypeScript references to the symbol at an absolute file position. Project files mentioning the symbol are loaded into the language server first, so results cover the whole project rather than only files opened earlier this session.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        includeDeclaration: { type: "boolean" },
      },
      required: ["file", "line", "column"],
      additionalProperties: false,
    },
  },
  {
    name: "lsp",
    description: "Run any official DevEco LSP operation: definition, references, hover, document/workspace symbols, implementation, or call hierarchy. Request line/character are 1-based, but the response is the raw LSP payload, so positions inside it are 0-based; the go_to_definition / find_references / get_hover / list_symbols / find_call_hierarchy wrappers normalise theirs to 1-based.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["goToDefinition", "findReferences", "hover", "documentSymbol", "workspaceSymbol", "goToImplementation", "prepareCallHierarchy", "incomingCalls", "outgoingCalls"],
        },
        filePath: { type: "string", description: "Absolute or project-relative source file path." },
        line: { type: "integer", minimum: 1 },
        character: { type: "integer", minimum: 1 },
        query: { type: "string", description: "Workspace-symbol search query; empty string requests all symbols." },
      },
      required: ["operation", "filePath", "line", "character"],
      additionalProperties: false,
    },
  },
  {
    name: "go_to_definition",
    description: "Go to the ArkTS/TypeScript definition at an absolute file position.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
      },
      required: ["file", "line", "column"],
      additionalProperties: false,
    },
  },
  {
    name: "get_hover",
    description: "Get ArkTS/TypeScript type information and documentation at an absolute file position.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
      },
      required: ["file", "line", "column"],
      additionalProperties: false,
    },
  },
  {
    name: "list_symbols",
    description: "List functions, classes, variables, and other symbols defined in an ArkTS/TypeScript file.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" } },
      required: ["file"],
      additionalProperties: false,
    },
  },
  {
    name: "find_call_hierarchy",
    description: "Find incoming callers or outgoing callees for an ArkTS/TypeScript symbol. For direction=incoming, project files mentioning the symbol are loaded into the language server first so callers outside the current module are found.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        line: { type: "integer", minimum: 1 },
        column: { type: "integer", minimum: 1 },
        direction: { type: "string", enum: ["incoming", "outgoing"] },
      },
      required: ["file", "line", "column", "direction"],
      additionalProperties: false,
    },
  },
  {
    name: "document_validate",
    description: "Check an SDD artifact (spec.md / plan.md / tasks.md) against the section structure its template mandates: missing required sections, duplicate headings, disallowed level-2 sections, and the level-2 ceiling. Reports; never blocks. Call it after writing the artifact.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the artifact. Relative paths resolve against the active project." },
        content: { type: "string", description: "Document text to validate instead of reading from disk. Wins over the file's contents when both are given." },
        documentType: {
          type: "string",
          enum: ["spec", "design", "tasks"],
          description: "Rule set to apply. Inferred from the basename (spec.md, plan.md, tasks.md) when omitted; plan.md maps to design.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ui_snapshot",
    description: "Capture the device screen over hdc and return it inline. Use this when you only need to see the screen; use ui_observe when you also need coordinates, since it gets both in one device round trip. Runs locally, so it still works when the CodeGenie child is unavailable. Captures at the display's own resolution, scaled down only when its long edge exceeds 2576px — the point past which a vision model resizes the image anyway, so a larger capture costs bytes without adding detail. Lower width when a long loop needs cheaper frames: image cost follows pixel area, so halving width quarters it.",
    inputSchema: {
      type: "object",
      properties: {
        hvd: { type: "string", description: "hdc connect key as printed by hdc_log list_devices; optional when exactly one device is connected." },
        localPath: { type: "string", description: "Where to write the image. Defaults to a timestamped file under the system temp directory." },
        width: { type: "integer", minimum: 64, maximum: 4096, description: "Capture width, aspect ratio preserved. Defaults to the display’s own width, capped so the long edge stays within 2576px. Lower it to cut image cost on a long loop; coordinateScale reports the ratio either way." },
        format: { type: "string", enum: ["jpeg", "png"], description: "jpeg (default) is lossy but small; png is lossless and uncapped, for pixel-exact work. Both come from snapshot_display. Format does not change image cost, which follows pixel area only." },
        displayId: { type: "integer", minimum: 0, description: "Only for multi-display devices. Left unset, the device picks its active display." },
        inline: { type: "boolean", description: "Return the image as a content block (default true). Set false to get only the JSON report and the path." },
        ifChangedFrom: { type: "string", description: "A frameSignature from an earlier ui_snapshot or ui_observe. The capture still happens, but when the screen is byte-identical the reply is unchanged:true with no image. This is how to wait for something to happen cheaply: it costs a capture (~0.4s) where a full ui_observe costs a capture plus a layout dump (~1.4s), and spends no image tokens while nothing is moving." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ui_find",
    description: "Locate on-screen controls in a uitest layout dump and return tap-ready device coordinates, without capturing a frame. Use ui_observe instead when you also want to see the screen. Exact where reading coordinates off a screenshot is not, and unlike get_app_ui_tree it does not require the debugged app to be in the foreground. Pass dumpPath to re-query a dump you already have instead of spending ~1.4s on another one.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Case-insensitive substring of the node's visible text." },
        key: { type: "string", description: "Exact match on the node's key (what ArkUI .id() sets). Survives copy and locale changes, unlike text." },
        type: { type: "string", description: "Exact component type, e.g. Text, Button, Image." },
        dumpPath: { type: "string", description: "Parse this existing dump instead of dumping again. The path returned by a previous call." },
        hvd: { type: "string", description: "hdc connect key as printed by hdc_log list_devices; optional when exactly one device is connected." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum matches to return (default 20); matchCount reports the true total." },
        onScreenOnly: { type: "boolean", description: "Drop nodes outside the screen box or marked invisible (default true). Their centres are in the dump but tapping them does nothing." },
        clickableOnly: { type: "boolean", description: "Keep only nodes the device reports as clickable. Usable on its own: the node that handles a tap is usually a container with no text of its own, wrapping the label you can see." },
        displayId: { type: "integer", minimum: 0, description: "Restrict matches to one display. Only for multi-display devices; a foldable or an external screen puts nodes from both displays in one dump." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ui_observe",
    description: "Capture the screen AND the layout tree in one device round trip, and return the frame inline beside tap-ready coordinates. This is the tool to reach for in a UI loop: the capture is overlapped with the dump on the device, which measured 1238ms against 1731ms for calling ui_snapshot and ui_find separately. Takes the same selectors as ui_find. Also returns structureSignature, which is stable while the layout is unchanged, so you can tell whether anything actually happened without re-reading the screen.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Case-insensitive substring of the node's visible text (or its accessibility label)." },
        key: { type: "string", description: "Exact match on the node's key (what ArkUI .id() sets). Survives copy and locale changes, unlike text." },
        type: { type: "string", description: "Exact component type, e.g. Text, Button, Image." },
        clickableOnly: { type: "boolean", description: "Keep only nodes the device reports as clickable. Usable on its own." },
        onScreenOnly: { type: "boolean", description: "Drop nodes outside the screen box or marked invisible (default true)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum matches to return (default 20); matchCount reports the true total." },
        displayId: { type: "integer", minimum: 0, description: "Restrict matches to one display, and capture that display. Only for multi-display devices; a foldable or an external screen puts nodes from both displays in one dump." },
        hvd: { type: "string", description: "hdc connect key as printed by hdc_log list_devices; optional when exactly one device is connected." },
        localPath: { type: "string", description: "Where to write the frame. Defaults to a timestamped file under the system temp directory." },
        width: { type: "integer", minimum: 64, maximum: 4096, description: "Capture width, aspect ratio preserved. Defaults to the display’s own width, capped so the long edge stays within 2576px." },
        inline: { type: "boolean", description: "Return the frame as a content block (default true)." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ui_tap",
    description: "Send a touch, gesture, or key event through uitest uiInput over hdc. Same actions as perform_ui_action but without the CodeGenie child, so it survives that child stalling. Prefer aiming click/doubleClick/longClick with key/text/type over passing x/y: coordinates go stale between the find and the tap (a point addressing a home-screen widget addressed the notification list moments later), and the selector form resolves and taps while holding the device. Note dircFling direction is the scroll direction, and flinging at a list boundary succeeds without moving anything.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["click", "doubleClick", "longClick", "swipe", "dircFling", "inputText", "keyEvent"],
        },
        key: { type: "string", description: "Aim a click/doubleClick/longClick at the node with this exact key instead of at coordinates. Refuses rather than guesses when it matches no node or several." },
        text: { type: "string", description: "Aim at the node whose visible text contains this, instead of at coordinates. For inputText this is the text to type, not a selector." },
        type: { type: "string", description: "Aim at the node of this exact component type, or narrow a key/text selector." },
        clickableOnly: { type: "boolean", description: "Narrow a selector to nodes the device reports as clickable. The node that handles a tap is often a container wrapping the label you can see." },
        verify: { type: "boolean", description: "After a selector-aimed tap, dump again and report whether the target is still present. Off by default: it doubles the cost." },
        x: { type: "integer", minimum: 0, description: "Device x for click/doubleClick/longClick/swipe/inputText. Omit when using a selector." },
        y: { type: "integer", minimum: 0, description: "Device y for click/doubleClick/longClick/swipe/inputText. Omit when using a selector." },
        x2: { type: "integer", minimum: 0, description: "Destination x for swipe." },
        y2: { type: "integer", minimum: 0, description: "Destination y for swipe." },
        direction: { type: "integer", enum: [0, 1, 2, 3], description: "dircFling scroll direction: 0 left, 1 right, 2 toward the top, 3 toward the bottom." },
        velocity: { type: "integer", minimum: 200, maximum: 40000, description: "Gesture speed in px/s for swipe and dircFling." },
        stepLength: { type: "integer", minimum: 1, description: "dircFling step length in px." },
        text: { type: "string", description: "Text for inputText. Anything without whitespace is quoted for the device shell and accepted as-is; text that mixes whitespace with \" $ ` or \\ is refused because hdc's own quoting leaves those live, and perform_ui_action stays available for it." },
        key1: { type: "string", description: "Key name or keycode, e.g. Back, Home, Power." },
        key2: { type: "string", description: "Second key of a combination." },
        key3: { type: "string", description: "Third key of a combination." },
        hvd: { type: "string", description: "hdc connect key as printed by hdc_log list_devices; optional when exactly one device is connected." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 600000 },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
];
