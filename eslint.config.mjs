import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/compiled/**", "apps/flutter/**/build/**", "apps/flutter/**/.dart_tool/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["apps/api/**/*.ts", "packages/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      globals: {
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    files: ["apps/miniprogram/**/*.ts"],
    languageOptions: {
      globals: {
        App: "readonly",
        Page: "readonly",
        wx: "readonly",
      },
    },
  },
  {
    files: ["apps/api/test/**/*.mjs", "apps/miniprogram/test/**/*.mjs", "scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        Buffer: "readonly",
        clearTimeout: "readonly",
        console: "readonly",
        fetch: "readonly",
        process: "readonly",
        setTimeout: "readonly",
        structuredClone: "readonly",
        URL: "readonly",
      },
    },
  },
);
