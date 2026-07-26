import { describe, it, expect } from "vitest";
import { evaluatePolicy } from "../policy";

describe("holding policy engine", () => {
  it("allows R0/R1 from day one", () => {
    expect(evaluatePolicy({ riskClass: "R0", trustLevel: "TRUSTED", autonomyLevel: 2 }).decision).toBe("ALLOW");
    expect(evaluatePolicy({ riskClass: "R1", trustLevel: "TRUSTED", autonomyLevel: 0 }).decision).toBe("ALLOW");
  });

  it("R2/R3 require approval below L4 and pass at L4+", () => {
    expect(evaluatePolicy({ riskClass: "R2", trustLevel: "TRUSTED", autonomyLevel: 2 }).decision).toBe("REQUIRE_APPROVAL");
    expect(evaluatePolicy({ riskClass: "R2", trustLevel: "TRUSTED", autonomyLevel: 4 }).decision).toBe("ALLOW");
    expect(evaluatePolicy({ riskClass: "R3", trustLevel: "TRUSTED", autonomyLevel: 3 }).decision).toBe("REQUIRE_APPROVAL");
    expect(evaluatePolicy({ riskClass: "R3", trustLevel: "TRUSTED", autonomyLevel: 5 }).decision).toBe("ALLOW");
  });

  it("R4/R5 NEVER auto-execute — founder-only at any autonomy/trust combination", () => {
    for (const riskClass of ["R4", "R5"] as const) {
      for (const autonomyLevel of [0, 4, 5]) {
        for (const trustLevel of ["TRUSTED", "UNTRUSTED"] as const) {
          const result = evaluatePolicy({ riskClass, trustLevel, autonomyLevel });
          expect(result.decision).toBe("REQUIRE_APPROVAL");
        }
      }
    }
  });

  it("untrusted provenance caps autonomy at R1 (injection gate)", () => {
    expect(evaluatePolicy({ riskClass: "R1", trustLevel: "UNTRUSTED", autonomyLevel: 2 }).decision).toBe("ALLOW");
    // Even an L4-promoted R2 workflow must pause when the INPUT is untrusted.
    expect(evaluatePolicy({ riskClass: "R2", trustLevel: "UNTRUSTED", autonomyLevel: 4 }).decision).toBe("REQUIRE_APPROVAL");
    expect(evaluatePolicy({ riskClass: "R3", trustLevel: "UNTRUSTED", autonomyLevel: 5 }).decision).toBe("REQUIRE_APPROVAL");
  });

  it("fails CLOSED on anything it cannot classify", () => {
    expect(evaluatePolicy({ riskClass: "R7" as never, trustLevel: "TRUSTED", autonomyLevel: 2 }).decision).toBe("DENY");
    expect(evaluatePolicy({ riskClass: "R1", trustLevel: "half-trusted" as never, autonomyLevel: 2 }).decision).toBe("DENY");
    expect(evaluatePolicy({ riskClass: "R2", trustLevel: "TRUSTED", autonomyLevel: 9 }).decision).toBe("DENY");
    expect(evaluatePolicy({ riskClass: "R2", trustLevel: "TRUSTED", autonomyLevel: 2.5 }).decision).toBe("DENY");
  });
});
