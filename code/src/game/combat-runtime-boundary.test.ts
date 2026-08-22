import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const app = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const runtime = readFileSync(new URL("./combat-runtime.ts", import.meta.url), "utf8");

describe("combat runtime import boundary", () => {
  it("keeps Phaser and TacticalScene out of the App static import graph", () => {
    expect(app).not.toMatch(/from ["']phaser["']/);
    expect(app).not.toMatch(/from ["']\.\/game\/TacticalScene["']/);
  });

  it("owns both runtime imports behind dynamic import()", () => {
    expect(runtime).toMatch(/import\("phaser"\)/);
    expect(runtime).toMatch(/import\("\.\/TacticalScene"\)/);
  });
});
