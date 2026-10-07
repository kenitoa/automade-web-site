import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-service/**",
      "exports/**",
      ".data/**",
      "test-results/**",
      "playwright-report/**",
      ".vite-cache/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["**/*.js", "**/*.jsx"],
    rules: {
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
);
