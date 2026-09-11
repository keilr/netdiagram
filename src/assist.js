"use strict";
/* Optional LLM assistant — drafts and revises netdiagram YAML.
 *
 * Design rules, in order of importance:
 *  1. OFFLINE FIRST. Nothing here runs, and no request is ever made, until the
 *     user picks a provider and presses Send. The build can drop this file
 *     entirely (`npm run build -- --no-assist`).
 *  2. THE MODEL PROPOSES, THE PARSER DISPOSES. Output is only ever YAML text
 *     that must survive parseSpec + lintSpec before it can reach the diagram,
 *     so a hallucination is a caught error rather than a silent corruption.
 *     generate() takes a `validate` callback and spends one repair round on the
 *     errors — which carry document paths, so they make excellent repair input.
 *  3. NOTHING LEAVES SILENTLY. The caller shows the exact payload first; a
 *     network topology is precisely what this tool's users must not leak.
 *
 * Two wire formats are supported. Most providers (Ollama, llama.cpp, LM Studio,
 * vLLM, OpenAI, OpenRouter, Groq, Together) speak OpenAI's /chat/completions.
 * Anthropic is its own shape: /messages, x-api-key + anthropic-version, a
 * top-level system string, and content blocks coming back. Browser calls to
 * Anthropic additionally need the explicit direct-browser-access opt-in.
 *
 * Runs in node (require, for tests) and in the browser, where the build
 * concatenates it after the core and it publishes window.Assist.
 */
(function (root) {

  /* ---------- providers ----------
   * Local engines first: they keep the topology on the machine, which is the
   * right default for this audience. `base` is an OpenAI-style root (…/v1) for
   * the openai shape, or the API root for anthropic. */
  const PROVIDERS = [
    { id: "ollama", label: "Ollama (local)", api: "openai", local: true,
      base: "http://localhost:11434/v1", model: "llama3.1", keyRequired: false,
      note: "Runs on your machine. From a file:// page, start Ollama with OLLAMA_ORIGINS=* or the browser blocks the request." },
    { id: "llamacpp", label: "llama.cpp server (local)", api: "openai", local: true,
      base: "http://localhost:8080/v1", model: "local-model", keyRequired: false,
      note: "llama-server --host 127.0.0.1 --port 8080." },
    { id: "lmstudio", label: "LM Studio (local)", api: "openai", local: true,
      base: "http://localhost:1234/v1", model: "local-model", keyRequired: false,
      note: "Enable the local server in LM Studio's Developer tab." },
    { id: "vllm", label: "vLLM (self-hosted)", api: "openai", local: true,
      base: "http://localhost:8000/v1", model: "meta-llama/Llama-3.1-8B-Instruct", keyRequired: false,
      note: "Point base at your inference host." },
    { id: "anthropic", label: "Anthropic — Claude", api: "anthropic", local: false,
      base: "https://api.anthropic.com/v1", model: "claude-sonnet-5", keyRequired: true,
      note: "Sends your diagram to Anthropic. claude-opus-5 is the most capable; claude-haiku-4-5-20251001 the fastest." },
    { id: "openai", label: "OpenAI", api: "openai", local: false,
      base: "https://api.openai.com/v1", model: "gpt-4o", keyRequired: true,
      note: "Sends your diagram to OpenAI." },
    { id: "openrouter", label: "OpenRouter", api: "openai", local: false,
      base: "https://openrouter.ai/api/v1", model: "anthropic/claude-sonnet-4", keyRequired: true,
      note: "Routes to many models behind one OpenAI-compatible endpoint." },
    { id: "groq", label: "Groq", api: "openai", local: false,
      base: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", keyRequired: true,
      note: "Sends your diagram to Groq." },
    { id: "custom", label: "Custom (OpenAI-compatible)", api: "openai", local: false,
      base: "", model: "", keyRequired: false,
      note: "Any endpoint exposing POST /chat/completions." },
  ];
  const providerById = id => PROVIDERS.find(p => p.id === id) || PROVIDERS[0];

  /* ---------- prompts ---------- */
  /* The schema is the contract. It is already in the page (SCHEMA), so the
   * model is told the real vocabulary instead of guessing at it. */
  function systemPrompt(schema) {
    return [
      "You write netdiagram specs: YAML describing a network as nodes, groups and connections.",
      "",
      "Rules:",
      "- Reply with YAML only. No prose, no explanation, no markdown fence.",
      "- Obey the JSON Schema below exactly. Use only keys and enum values it allows.",
      "- Every connection's from/to must be an id that exists in the document.",
      "- ids are unique across nodes AND groups, at every nesting level.",
      "- A node listed inside another node's `nodes:` must NOT also appear in a group's `nodes:`.",
      "- Give nodes an ip when you know it, and groups a cidr that actually contains their members' addresses.",
      "- Prefer connecting a hub to a GROUP rather than to each member: it keeps the drawing compact.",
      "- Label connections \"<proto>/<port> <context>\", e.g. \"tcp/443 https\".",
      "",
      "JSON Schema:",
      JSON.stringify(schema),
    ].join("\n");
  }

  function userPrompt({ instruction, currentYaml }) {
    if (!currentYaml || !currentYaml.trim()) return String(instruction || "").trim();
    return [
      "Current document:",
      "",
      String(currentYaml).trim(),
      "",
      "Task: " + String(instruction || "").trim(),
      "",
      "Return the COMPLETE updated document, not a fragment or a diff.",
    ].join("\n");
  }

  /* Errors carry document paths ('nodes.3.id'), which is unusually good repair
   * input — name them explicitly rather than saying "it failed". */
  function repairPrompt(errors) {
    const lines = (errors || []).map(e => {
      const at = Array.isArray(e.path) ? e.path.join(".") : e.path;
      return "- " + (at ? `[${at}] ` : "") + e.message;
    });
    return [
      "That document was rejected:",
      "",
      lines.join("\n"),
      "",
      "Return the COMPLETE corrected document as YAML only.",
    ].join("\n");
  }

  /* ---------- wire formats ---------- */
  /* Pure: returns what to send, so a caller (or a test) can inspect it before
   * any network access happens. */
  function buildRequest(cfg, { system, messages }) {
    const provider = providerById(cfg.providerId);
    const base = String(cfg.base || provider.base || "").replace(/\/+$/, "");
    const model = cfg.model || provider.model;
    const key = cfg.key || "";
    const maxTokens = cfg.maxTokens || 4096;

    if (provider.api === "anthropic") {
      const headers = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        /* required for calls made straight from a page rather than a server */
        "anthropic-dangerous-direct-browser-access": "true",
      };
      if (key) headers["x-api-key"] = key;
      return {
        url: base + "/messages",
        headers,
        body: { model, max_tokens: maxTokens, temperature: 0, system, messages },
      };
    }
    const headers = { "content-type": "application/json" };
    if (key) headers.authorization = "Bearer " + key;
    return {
      url: base + "/chat/completions",
      headers,
      body: {
        model,
        temperature: 0,
        max_tokens: maxTokens,
        messages: [{ role: "system", content: system }, ...messages],
      },
    };
  }

  function parseResponse(cfg, json) {
    const provider = providerById(cfg.providerId);
    if (json && json.error) throw new Error(json.error.message || String(json.error));
    if (provider.api === "anthropic") {
      const blocks = (json && json.content) || [];
      const text = blocks.filter(b => b && b.type === "text").map(b => b.text).join("");
      if (!text) throw new Error("the model returned no text");
      return text;
    }
    const choice = json && json.choices && json.choices[0];
    const text = choice && choice.message && choice.message.content;
    if (!text) throw new Error("the model returned no text");
    return text;
  }

  /* Models wrap YAML in a fence however often you ask them not to. */
  function extractYaml(text) {
    const s = String(text || "").trim();
    const fenced = /```(?:ya?ml)?\s*\n([\s\S]*?)\n?```/i.exec(s);
    return (fenced ? fenced[1] : s).trim();
  }

  /* ---------- one call ---------- */
  async function complete(cfg, { system, messages }, fetchImpl) {
    const doFetch = fetchImpl || (typeof fetch !== "undefined" ? fetch : null);
    if (!doFetch) throw new Error("no fetch available in this environment");
    const req = buildRequest(cfg, { system, messages });
    let res;
    try {
      res = await doFetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: JSON.stringify(req.body),
      });
    } catch (e) {
      /* the common ones: endpoint down, or the browser blocked a cross-origin
       * call to a local server — say so, the raw TypeError helps nobody */
      throw new Error(
        `could not reach ${req.url} (${e.message}). If it is a local server, it must allow ` +
        "requests from this page's origin — e.g. start Ollama with OLLAMA_ORIGINS=*.",
        { cause: e });
    }
    let json = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch (e) { /* non-JSON error body */ }
    if (!res.ok) {
      const msg = (json && json.error && (json.error.message || json.error.type)) || text.slice(0, 300);
      throw new Error(`${res.status} ${res.statusText}: ${msg}`);
    }
    return parseResponse(cfg, json);
  }

  /* ---------- generate + repair ----------
   * `validate(yaml)` -> null when good, else an array of {path, message}.
   * Returns { yaml, attempts, repaired }. */
  async function generate(cfg, opts, fetchImpl) {
    const { schema, instruction, currentYaml, validate } = opts;
    const system = systemPrompt(schema);
    const messages = [{ role: "user", content: userPrompt({ instruction, currentYaml }) }];

    let text = await complete(cfg, { system, messages }, fetchImpl);
    let yaml = extractYaml(text);
    let errors = validate ? validate(yaml) : null;
    if (!errors || !errors.length) return { yaml, attempts: 1, repaired: false };

    /* one repair round — the model sees its own output and the exact complaints */
    messages.push({ role: "assistant", content: yaml });
    messages.push({ role: "user", content: repairPrompt(errors) });
    text = await complete(cfg, { system, messages }, fetchImpl);
    yaml = extractYaml(text);
    errors = validate ? validate(yaml) : null;
    if (errors && errors.length) {
      const e = new Error("the model could not produce a valid document:\n" +
        errors.map(x => "  " + x.message).join("\n"));
      e.yaml = yaml;          // keep it: the user may still want to look
      e.errors = errors;
      throw e;
    }
    return { yaml, attempts: 2, repaired: true };
  }

  /* ---------- settings ----------
   * The API key is NOT persisted unless the user asks: for this audience a key
   * sitting in localStorage is a real finding, and the topology matters more. */
  const STORAGE_KEY = "netdiagram:v1:assist";
  function loadConfig(storage) {
    const base = { providerId: PROVIDERS[0].id, base: "", model: "", key: "", remember: false };
    if (!storage) return base;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      return raw ? Object.assign(base, JSON.parse(raw)) : base;
    } catch (e) { return base; }
  }
  function saveConfig(storage, cfg) {
    if (!storage) return;
    const out = {
      providerId: cfg.providerId, base: cfg.base, model: cfg.model,
      remember: !!cfg.remember, key: cfg.remember ? cfg.key : "",
    };
    try { storage.setItem(STORAGE_KEY, JSON.stringify(out)); } catch (e) { /* ignore */ }
  }

  const api = { PROVIDERS, providerById, systemPrompt, userPrompt, repairPrompt,
    buildRequest, parseResponse, extractYaml, complete, generate,
    loadConfig, saveConfig, STORAGE_KEY };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Assist = api;
})(typeof window !== "undefined" ? window : globalThis);
