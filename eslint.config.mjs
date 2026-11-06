import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Fixtures are user code for the kernel: they import `dext` and are type-checked
  // by the generated `.dext/tsconfig.json`, not by this repository's project.
  { ignores: ["test/fixtures/**/*.mjs", "test/fixtures/**/*.ts"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-confusing-void-expression": "off"
    }
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-unsafe-assignment": "off"
    }
  },
  {
    // The kernel is plain ESM JavaScript: it is type-free by design, so the
    // type-aware rules have nothing to work with.
    files: ["src/**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        console: "readonly",
        URL: "readonly",
        setImmediate: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly"
      }
    }
  }
);
