import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Hooks that load a heavy module graph can spend longer than the 10s default
    // transforming it while the whole suite runs in parallel, which surfaces as a
    // spurious "Hook timed out" failure rather than a real problem.
    hookTimeout: 60000
  }
});
