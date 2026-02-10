import js from "@eslint/js";
import tseslint from "typescript-eslint";
import nodePlugin from "eslint-plugin-n";

export default tseslint.config(
  // Global ignores (replaces .eslintignore)
  { ignores: ["dist/", "node_modules/", "coverage/"] },
  
  // Base JS & Node configs
  js.configs.recommended,
  nodePlugin.configs["flat/recommended-script"],
  
  // TypeScript configs
  ...tseslint.configs.recommended,
  
  {
    languageOptions: {
      globals: {
        // Defines Node.js global variables
        process: "readonly",
        __dirname: "readonly",
      },
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Custom tweaks
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "n/no-missing-import": "off", // Often handled better by TS itself
      "no-console": "warn",
    },
  },
);