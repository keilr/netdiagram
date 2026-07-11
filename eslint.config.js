"use strict";
/* Flat ESLint config. The sources run in three shapes:
 *  - src/netdiagram.js : CommonJS core, runs in BOTH node and the browser
 *  - src/app.js        : browser wiring, concatenated (not bundled) after the
 *                        core + build-injected globals, so its cross-file names
 *                        are globals here, not imports
 *  - src/editor.js     : ES module bundled by esbuild
 * scripts/ and test/ are plain node CommonJS. */
const js = require("@eslint/js");
const globals = require("globals");

const shared = {
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
  "no-empty": ["error", { allowEmptyCatch: true }],
};

module.exports = [
  { ignores: ["dist/", "node_modules/", ".claude/"] },
  js.configs.recommended,

  {
    files: ["src/netdiagram.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: shared,
  },

  {
    files: ["src/app.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "script",
      globals: {
        ...globals.browser,
        // vendored / build-injected
        ELK: "readonly", jsyaml: "readonly", EXAMPLES: "readonly", SCHEMA: "readonly",
        // from src/editor.js
        makeEditor: "readonly",
        // from src/netdiagram.js (concatenated ahead of app.js at build time)
        parseSpec: "readonly", buildElk: "readonly", renderSVG: "readonly",
        esc: "readonly", dirOf: "readonly", ipsOf: "readonly",
      },
    },
    rules: shared,
  },

  {
    files: ["src/editor.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: shared,
  },

  {
    files: ["scripts/**/*.js", "test/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node },
    },
    rules: shared,
  },
];
