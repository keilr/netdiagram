/* CodeMirror 6 editor with YAML + JSON Schema autocomplete/lint/hover.
 * Bundled by esbuild into the dist HTML — not run directly. */
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { yaml, yamlLanguage } from "@codemirror/lang-yaml";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { yamlSchema } from "codemirror-json-schema/yaml";

/* ---- value completions ---------------------------------------------------
 * codemirror-json-schema (0.8.x) completes property KEYS in YAML mode but not
 * VALUES, so enum-ish value hints live here. Vocabularies are read from the
 * JSON schema so schema and autocomplete cannot drift; link endpoints
 * (from/to) and group member lists complete against ids found in the doc. */
function vocabularies(schema) {
  const defs = schema.$defs || {};
  const enums = s => (s ? s.enum || (s.anyOf || []).flatMap(a => a.enum || []) : []);
  const typeValues = enums(defs.node?.properties?.type);
  return {
    nodes:   { type: typeValues, icon: typeValues,
               os: defs.node?.properties?.os?.examples || [] },
    groups:  { class: enums(defs.group?.properties?.class) },
    links:   { protocol: defs.link?.properties?.protocol?.examples || [],
               direction: enums(defs.link?.properties?.direction) },
    diagram: { direction: enums(schema.properties?.diagram?.properties?.direction) },
  };
}

const idsIn = text =>
  [...new Set([...text.matchAll(/(?:^|[\s{,])id:\s*([^\s,}#]+)/gm)].map(m => m[1]))];

// lines of one top-level section — so member lists suggest node ids only
function topSection(text, name) {
  const out = [];
  let inSec = false;
  for (const ln of text.split("\n")) {
    const top = /^([A-Za-z_][\w-]*):/.exec(ln);
    if (top) inSec = top[1] === name;
    if (inSec) out.push(ln);
  }
  return out.join("\n");
}

export function valueCompletion(schema) {
  const vocab = vocabularies(schema);
  return ctx => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);

    // enclosing top-level section (nodes / groups / links / diagram)
    let section = null;
    for (let n = line.number; n >= 1 && !section; n--)
      section = (/^([A-Za-z_][\w-]*):/.exec(ctx.state.doc.line(n).text) || [])[1];
    if (!section) return null;

    // rightmost `key: partial` fragment — covers block and flow style
    let words = null, partial = "", kind = "keyword", m;
    if ((m = /([A-Za-z_][\w-]*):\s+([\w./-]*)$/.exec(before))) {
      partial = m[2];
      if (section === "links" && (m[1] === "from" || m[1] === "to")) {
        words = idsIn(ctx.state.doc.toString());
        kind = "variable";
      } else {
        words = (vocab[section] || {})[m[1]] || null;
      }
    } else if ((m = /nodes:\s*\[[^\]]*?([\w./-]*)$/.exec(before)) && section === "groups") {
      partial = m[1];                       // inside `nodes: [a, b` — member ids
      words = idsIn(topSection(ctx.state.doc.toString(), "nodes"));
      kind = "variable";
    }
    if (!words || !words.length) return null;

    return {
      from: ctx.pos - partial.length,
      options: words.map(w => ({ label: String(w), type: kind })),
      validFor: /^[\w./ -]*$/,   // keep filtering while multi-word values are typed
    };
  };
}

window.makeEditor = function(parent, schema, onChange) {
  const view = new EditorView({
    state: EditorState.create({
      extensions: [
        history(),
        drawSelection(),
        lineNumbers(),
        highlightActiveLine(),
        lintGutter(),
        yaml(),
        oneDark,
        EditorView.theme({
          "&": { height: "100%" },
          ".cm-scroller": { overflow: "auto", fontSize: "12.5px", lineHeight: "1.6" },
          "&.cm-editor": { backgroundColor: "var(--slate)" },
          ".cm-gutters": { backgroundColor: "var(--slate-2)", borderRight: "1px solid #2c3542" },
        }),
        ...yamlSchema(schema),
        yamlLanguage.data.of({ autocomplete: valueCompletion(schema) }),
        autocompletion(),   // the popup itself — without this no source ever shows
        closeBrackets(),
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...historyKeymap,
          ...lintKeymap,
          ...completionKeymap,
          indentWithTab,
        ]),
        EditorView.updateListener.of(v => {
          if (v.docChanged) onChange(v.state.doc.toString());
        }),
      ],
    }),
    parent,
  });

  return {
    get value() { return view.state.doc.toString(); },
    setValue(text) {
      const len = view.state.doc.length;
      if (view.state.doc.toString() !== text)
        view.dispatch({ changes: { from: 0, to: len, insert: text } });
    },
  };
};
