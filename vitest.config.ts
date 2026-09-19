import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    environment: "node",
    // A developer's opt-in API setting must never make the offline suite pay
    // for real evaluations. Jev tests explicitly opt in with mocked transport.
    env: { AU_LAW_JEV: "false", TYPESAFE_API_KEY: "" },
  },
})
