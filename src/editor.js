/* CodeMirror 6 editor with YAML + JSON Schema autocomplete/lint/hover.
 * Bundled by esbuild into the dist HTML — not run directly. */
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { yaml } from "@codemirror/lang-yaml";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { lintGutter, lintKeymap } from "@codemirror/lint";
import { oneDark } from "@codemirror/theme-one-dark";
import { yamlSchema } from "codemirror-json-schema/yaml";

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
