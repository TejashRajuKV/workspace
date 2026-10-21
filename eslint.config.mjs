import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

// The project is plain JavaScript + JSX: ESLint needs the JSX parser options and
// browser globals for src/, node globals for server/, scripts/ and tests/.
const eslintConfig = [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "out/**",
      "build/**",
      "examples/**",
      "download/**",
      "skills/**",
      "mini-services/**",
      "public/monaco/**",
      "scripts/**",
      "tests/**",
      "docs/**",
      ".zscripts/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser, ...globals.node },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // Kept off, exactly as before the migration — the codebase predates it.
      "react-hooks/exhaustive-deps": "off",
      "no-unused-vars": "off",
      "no-undef": "off",
      "no-empty": "off",
      "no-case-declarations": "off",
      "no-fallthrough": "off",
      "prefer-const": "off",
      "no-console": "off",
    },
  },
  {
    // validateFilePath() deliberately matches control characters in order to
    // reject them — that is the point of the rule violation, not a mistake.
    files: ["src/shared/protocol.js"],
    rules: { "no-control-regex": "off" },
  },
];

export default eslintConfig;