import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Follow Prisma's actual config dependency, rather than an unrelated top-level
// copy. Prisma passes this same `deepmerge` function into its c12 config loader.
const require = createRequire(new URL("../../../db/package.json", import.meta.url));
const prismaRequire = createRequire(require.resolve("prisma/package.json"));
const configRequire = createRequire(prismaRequire.resolve("@prisma/config"));
const mergePath = configRequire.resolve("deepmerge-ts");

describe("Prisma configuration merge dependency", () => {
  for (const method of ["deepmerge", "deepmergeInto"] as const) {
    it(`${method} bounds cyclic object graphs without exhausting the stack`, () => {
      const child = spawnSync(process.execPath, ["--max-old-space-size=64", "-e", `
        const { ${method} } = require(${JSON.stringify(mergePath)});
        const left = {}; left.self = left;
        const right = {}; right.self = right;
        try {
          ${method}(left, right);
          process.stdout.write("bounded");
        } catch (error) {
          if (error instanceof RangeError) process.exitCode = 2;
          else process.stdout.write("bounded");
        }
      `], { encoding: "utf8", timeout: 2000, maxBuffer: 4096 });
      expect(child.error?.message).toBeUndefined();
      expect(child.status).toBe(0);
      expect(child.stdout).toBe("bounded");
    });
  }

  it("preserves nested configuration merging for ordinary records", () => {
    const { deepmerge } = configRequire("deepmerge-ts");
    expect(deepmerge({ database: { schema: "schema.prisma" } }, { database: { timeout: 30 } }))
      .toEqual({ database: { schema: "schema.prisma", timeout: 30 } });
  });
});
