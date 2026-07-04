import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  {
    // dist and tools/preview/*.mjs are build output; node_modules is vendored.
    ignores: [
      "dist",
      "**/node_modules",
      "**/*.tsbuildinfo",
      "tools/preview/*.mjs",
    ],
  },

  // Base rules for all TypeScript/JavaScript.
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Match TypeScript's noUnusedLocals/noUnusedParameters convention:
      // a leading underscore marks something intentionally unused.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  // Browser + React source.
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs["recommended-latest"].rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
    },
  },

  // Node-side code: tests, tooling, and config files.
  {
    files: [
      "test/**/*.ts",
      "tools/**/*.{ts,mjs}",
      "*.{js,ts,mjs}",
      "vite.config.ts",
    ],
    languageOptions: {
      globals: globals.node,
    },
  },

  // Disable stylistic rules that conflict with Prettier (keep last).
  prettier,
);
