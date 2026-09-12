#!/usr/bin/env node
"use strict";
/* MCP server — netdiagram as a tool for LLM agents.
 *
 * Speaks MCP over stdio: newline-delimited JSON-RPC 2.0. It exposes the same
 * pipeline the CLIs use, so an agent can author a spec, have it VALIDATED by
 * code rather than by hope, render it, and diff two revisions.
 *
 *   claude mcp add netdiagram -- node /path/to/netdiagram/scripts/mcp.js
 *
 * Design notes:
 *  - stdout is the protocol channel. NOTHING may be written to it except
 *    JSON-RPC messages; all diagnostics go to stderr.
 *  - Tools never throw at the agent: a spec error comes back as isError with
 *    the full message, because those messages (with document paths) are the
 *    most useful thing the agent can act on.
 *  - Nothing here is loaded by the browser build — dist/netdiagram.html is
 *    untouched by this file, so offline users are unaffected.
 */
const fs = require("fs");
const path = require("path");
const ELK = require("elkjs");
const nd = require("../src/netdiagram.js");
const { detectImport, importAs } = require("../src/importers.js");

const root = path.join(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const SCHEMA = JSON.parse(fs.readFileSync(path.join(root, "netdiagram-schema.json"), "utf8"));
const elk = new ELK();

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(`netdiagram MCP server (stdio)

  node scripts/mcp.js            run the server (JSON-RPC 2.0 over stdin/stdout)
  node scripts/mcp.js --tools    list the tool names and exit

Register with an agent, e.g.:
  claude mcp add netdiagram -- node ${path.join(root, "scripts/mcp.js")}
`);
  process.exit(0);
}

/* ---------------- the pipeline, shared with scripts/render.js ---------------- */
async function layoutOf(spec) {
  const pass1 = await elk.layout(nd.buildElk(spec));
  const ported = nd.assignPorts(nd.buildElk(spec), pass1);
  return ported ? elk.layout(ported) : pass1;
}
/* a view narrows the doc before anything else, exactly as the CLI does */
function specOf(yaml, view) {
  const source = nd.parseSpec(yaml);
  if (!view) return source;
  const v = nd.viewById(source.doc, view);
  if (!v) {
    const have = nd.viewsOf(source.doc).map((x) => `"${x.id}"`).join(", ");
    throw new Error(`unknown view "${view}" — this spec defines ${have || "none"}`);
  }
  return nd.specFromDoc(nd.applyView(source.doc, v, source));
}
const counts = (spec) =>
  `${spec.nodeMap.size} nodes, ${spec.groupMap.size} groups, ${(spec.doc.connections || []).length} connections`;

/* ---------------- tools ---------------- */
const S = {
  yaml: { type: "string", description: "netdiagram YAML source" },
  view: { type: "string", description: "optional id from the spec's views: list — narrows the diagram first" },
};

const TOOLS = [
  {
    name: "netdiagram_schema",
    description:
      "Return the netdiagram JSON Schema. Read this FIRST when authoring a spec: it is the authoritative " +
      "list of keys, device types, group classes and view options.",
    inputSchema: { type: "object", properties: {} },
    run: () => JSON.stringify(SCHEMA, null, 2),
  },
  {
    name: "netdiagram_check",
    description:
      "Validate a spec and lint the architecture it describes. Returns JSON: syntax errors (unknown " +
      "endpoints, duplicate ids), plus findings such as an address in no declared subnet, duplicate IPs, " +
      "overlapping CIDRs, a pair both blocked and allowed, and warnings for vocabulary that renders " +
      "silently wrong. Use this after every edit — it is cheaper and more reliable than re-reading the YAML.",
    inputSchema: {
      type: "object",
      properties: { yaml: S.yaml, strict: { type: "boolean", description: "treat warnings as failures" } },
      required: ["yaml"],
    },
    run: ({ yaml, strict }) => {
      let spec;
      try {
        spec = nd.parseSpec(String(yaml));
      } catch (e) {
        return JSON.stringify(
          { ok: false, stage: "parse", errors: e.errors || [{ message: e.message }] }, null, 2);
      }
      const findings = nd.lintSpec(spec);
      const errors = findings.filter((f) => f.severity === "error");
      const warnings = findings.filter((f) => f.severity === "warning");
      return JSON.stringify(
        { ok: !errors.length && !(strict && warnings.length), stage: "lint",
          summary: counts(spec), errors, warnings }, null, 2);
    },
  },
  {
    name: "netdiagram_render",
    description:
      "Lay out and render a spec to SVG. Writes to out_path when given (preferred — an SVG is large); " +
      "otherwise returns a summary. Set include_svg to get the markup back inline.",
    inputSchema: {
      type: "object",
      properties: {
        yaml: S.yaml,
        out_path: { type: "string", description: "file to write the SVG to" },
        theme: { type: "string", enum: ["paper", "blueprint"] },
        date: { type: "string", description: "title-block date (YYYY-MM-DD) — pin it for reproducible output" },
        view: S.view,
        include_svg: { type: "boolean", description: "return the SVG markup in the response" },
      },
      required: ["yaml"],
    },
    run: async ({ yaml, out_path, theme, date, view, include_svg }) => {
      const spec = specOf(String(yaml), view);
      const svg = nd.renderSVG(spec, await layoutOf(spec), { theme, date, source: String(yaml) });
      const out = [`rendered ${counts(spec)}${view ? ` (view ${view})` : ""}`];
      if (out_path) {
        fs.writeFileSync(out_path, svg);
        out.push(`written to ${out_path} (${Math.round(svg.length / 1024)} KB)`);
      }
      if (include_svg || !out_path) out.push(include_svg ? svg : `${Math.round(svg.length / 1024)} KB of SVG (pass out_path to save it, or include_svg to see it)`);
      return out.join("\n");
    },
  },
  {
    name: "netdiagram_rules",
    description:
      "Derive the firewall-rule table from the connections: one directed rule per connection with source " +
      "and destination addresses, protocol and port. Pairs inside the same zone are excluded (they need " +
      "no rule), a bidirectional connection yields two rows, and a blocked one none.",
    inputSchema: {
      type: "object",
      properties: { yaml: S.yaml, format: { type: "string", enum: ["json", "csv"], description: "default json" }, view: S.view },
      required: ["yaml"],
    },
    run: ({ yaml, format, view }) => {
      const spec = specOf(String(yaml), view);
      const { rules, excluded } = nd.connectionRules(spec);
      if (format === "csv") return nd.rulesToCsv(rules);
      return JSON.stringify({ rules, excluded_same_zone: excluded }, null, 2);
    },
  },
  {
    name: "netdiagram_diff",
    description:
      "Compare two revisions of a spec and report what changed: nodes, groups and connections marked " +
      "added / removed / changed. Use it to describe the impact of an edit before proposing it.",
    inputSchema: {
      type: "object",
      properties: { base_yaml: { type: "string" }, current_yaml: { type: "string" } },
      required: ["base_yaml", "current_yaml"],
    },
    run: ({ base_yaml, current_yaml }) => {
      const base = nd.parseSpec(String(base_yaml)).doc;
      const cur = nd.parseSpec(String(current_yaml)).doc;
      const d = nd.diffDocs(base, cur);
      const list = (m) => [...m].map(([k, v]) => ({ id: k, status: v }));
      return JSON.stringify(
        { counts: d.counts, nodes: list(d.status.nodes), groups: list(d.status.groups),
          connections: list(d.status.connections) }, null, 2);
    },
  },
  {
    name: "netdiagram_import",
    description:
      "Convert an existing inventory into a netdiagram spec: an Ansible inventory (INI/YAML/--list JSON), " +
      "Terraform state (show -json or .tfstate), or a NetBox export. Produces nodes and groups; " +
      "inventories do not describe traffic, so connections are left for you to add.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "the inventory content" },
        kind: { type: "string", enum: ["ansible", "terraform", "netbox"], description: "detected when omitted" },
        filename: { type: "string", description: "helps detection (e.g. hosts.ini)" },
      },
      required: ["text"],
    },
    run: ({ text, kind, filename }) => {
      const r = kind ? importAs(kind, String(text)) : detectImport(String(text), filename || "");
      if (!r) throw new Error("unrecognized inventory format — pass kind: ansible | terraform | netbox");
      return `# ${r.label}: ${r.summary}\n${r.yaml}`;
    },
  },
  {
    name: "netdiagram_views",
    description: "List the named views a spec defines (views:), with what each one narrows to.",
    inputSchema: { type: "object", properties: { yaml: S.yaml }, required: ["yaml"] },
    run: ({ yaml }) => {
      const spec = nd.parseSpec(String(yaml));
      const views = nd.viewsOf(spec.doc);
      if (!views.length) return "this spec defines no views";
      return JSON.stringify(views.map((v) => {
        const d = nd.applyView(spec.doc, v, spec);
        return { id: String(v.id), title: v.title ?? null, focus: v.focus ?? null,
          depth: v.depth ?? null, tags: v.tags ?? null,
          nodes: nd.flatNodes(d).length, connections: (d.connections || []).length };
      }), null, 2);
    },
  },
  {
    name: "netdiagram_extract",
    description:
      "Recover the YAML source embedded in an SVG that netdiagram exported, so a diagram pasted into a " +
      "wiki can be read back and edited.",
    inputSchema: {
      type: "object",
      properties: { svg: { type: "string", description: "SVG markup, or a path to an .svg file" } },
      required: ["svg"],
    },
    run: ({ svg }) => {
      let text = String(svg);
      if (!/<svg/i.test(text) && fs.existsSync(text)) text = fs.readFileSync(text, "utf8");
      const src = nd.extractSource(text);
      if (src == null) throw new Error("no embedded netdiagram source in that SVG");
      return src;
    },
  },
];

if (process.argv.includes("--tools")) {
  process.stdout.write(TOOLS.map((t) => t.name).join("\n") + "\n");
  process.exit(0);
}

/* ---------------- JSON-RPC over stdio ---------------- */
const PROTOCOL_VERSION = "2024-11-05";
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function callTool(name, args) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `unknown tool "${name}"` }], isError: true };
  try {
    const text = await tool.run(args || {});
    return { content: [{ type: "text", text: String(text) }] };
  } catch (e) {
    /* spec errors are the useful payload — hand them back, don't bury them */
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "initialize":
      return reply(id, {
        /* echo the client's version when it names one, so we don't fight over it */
        protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "netdiagram", version: pkg.version },
      });
    case "notifications/initialized":
    case "initialized":
      return;                                   // notification: no reply
    case "ping":
      return isRequest && reply(id, {});
    case "tools/list":
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call":
      return reply(id, await callTool(params && params.name, params && params.arguments));
    default:
      if (isRequest) replyError(id, -32601, `method not found: ${method}`);
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      continue;
    }
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, e.message);
      else process.stderr.write(`netdiagram-mcp: ${e.message}\n`);
    });
  }
});
process.stdin.on("end", () => process.exit(0));
