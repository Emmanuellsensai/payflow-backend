import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      // Unused arguments prefixed with _ are deliberate, e.g. Express's
      // four-argument error handler.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Values must be bound as parameters, not interpolated into SQL. A
      // template literal inside prepare() is how a string-built query with
      // user input would arrive. Fragments that are provably static may opt
      // out with an eslint-disable-next-line comment that says why, so every
      // exception is visible in review.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.property.name='prepare'] TemplateLiteral[expressions.length>0]",
          message:
            "Do not build SQL from an interpolated template literal; bind values with ? parameters. If the interpolation is a vetted static fragment, disable this rule for the line and explain why.",
        },
      ],
    },
  },
);
