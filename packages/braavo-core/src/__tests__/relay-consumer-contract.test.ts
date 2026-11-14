/**
 * QA-BRA-01 — relay protokolü TÜKETİCİ paritesi (mobil + masaüstü + CLI).
 * parity.test.ts API kopyasıyla bayt eşitliğini korur; bu dosya ise tüketicilerin bağlandığı DIŞA AÇIK
 * yüzeyi (ihraç adları, sabitler, mesaj şekilleri) sabitler. Mobil/masaüstü kopyası bu alanlardan
 * birinin adı/tipi/sınırı değiştiğinde burada kırılır; kasıtlı değişiklikte anlık görüntü bilinçli güncellenir.
 */
import { describe, expect, it } from "vitest";
import { relay } from "../index";
import * as direct from "../relay-protocol";
import { z } from "zod";

/** Şemayı tüketiciyi ilgilendiren özetine indirir (tür, sınır, enum, zorunluluk). */
function shape(schema: z.ZodType): unknown {
  const walk = (n: any): any => {
    if (n.anyOf) return { anyOf: n.anyOf.map(walk) };
    const o: any = {};
    for (const k of ["type", "const", "enum", "minLength", "maxLength", "minimum", "maximum", "maxItems", "format"]) if (n[k] !== undefined) o[k] = n[k];
    if (n.properties) {
      o.props = Object.fromEntries(Object.entries(n.properties).map(([k, v]) => [k, walk(v)]));
      o.required = [...(n.required ?? [])].sort();
    }
    if (n.items) o.items = walk(n.items);
    return o;
  };
  return walk(z.toJSONSchema(schema, { io: "input" }));
}

describe("relay dışa açık yüzey", () => {
  it("index `relay` ad alanı ve doğrudan modül aynı ihraçları taşır (adlar sabit)", () => {
    expect(Object.keys(relay).sort()).toEqual(Object.keys(direct).sort());
    expect(Object.keys(relay).sort()).toMatchInlineSnapshot(`
      [
        "AgentTurnEventSchema",
        "ApprovalRequestEventSchema",
        "ApproveCommandSchema",
        "AuditEventSchema",
        "BASE_EVENT_TYPES",
        "ControlCommandSchema",
        "KillCommandSchema",
        "MAX_ACTION_ID_LEN",
        "MAX_ACTION_KIND_LEN",
        "MAX_CWD_LEN",
        "MAX_LABEL_LEN",
        "MAX_OUTPUT_B64_LEN",
        "MAX_SNAPSHOT_AGENTS",
        "MAX_SNAPSHOT_ROUTINES",
        "MAX_TEXT_LEN",
        "OutputEventSchema",
        "PANEL_SNAPSHOT",
        "PanelSnapshotEventSchema",
        "RejectCommandSchema",
        "SESSION_STATES",
        "SURFACES",
        "SessionEventInputSchema",
        "SessionRegistrationSchema",
        "StatusEventSchema",
        "SteerCommandSchema",
        "deliverableTo",
        "parseIncludedEventTypes",
        "redact",
        "redactControlCommand",
        "redactSessionEventInput",
        "redactStructuredId",
      ]
    `);
  });

  it("sabitler (sınırlar, yüzeyler, durumlar, olay türleri)", () => {
    expect({
      MAX_TEXT_LEN: relay.MAX_TEXT_LEN,
      MAX_OUTPUT_B64_LEN: relay.MAX_OUTPUT_B64_LEN,
      MAX_ACTION_ID_LEN: relay.MAX_ACTION_ID_LEN,
      MAX_ACTION_KIND_LEN: relay.MAX_ACTION_KIND_LEN,
      MAX_LABEL_LEN: relay.MAX_LABEL_LEN,
      MAX_CWD_LEN: relay.MAX_CWD_LEN,
      MAX_SNAPSHOT_AGENTS: relay.MAX_SNAPSHOT_AGENTS,
      MAX_SNAPSHOT_ROUTINES: relay.MAX_SNAPSHOT_ROUTINES,
      PANEL_SNAPSHOT: relay.PANEL_SNAPSHOT,
      SURFACES: relay.SURFACES,
      SESSION_STATES: relay.SESSION_STATES,
      BASE_EVENT_TYPES: relay.BASE_EVENT_TYPES,
    }).toMatchInlineSnapshot(`
      {
        "BASE_EVENT_TYPES": [
          "approval-request",
          "agent-turn",
          "output",
          "audit",
          "status",
        ],
        "MAX_ACTION_ID_LEN": 200,
        "MAX_ACTION_KIND_LEN": 120,
        "MAX_CWD_LEN": 1024,
        "MAX_LABEL_LEN": 200,
        "MAX_OUTPUT_B64_LEN": 200000,
        "MAX_SNAPSHOT_AGENTS": 50,
        "MAX_SNAPSHOT_ROUTINES": 50,
        "MAX_TEXT_LEN": 4000,
        "PANEL_SNAPSHOT": "panel-snapshot",
        "SESSION_STATES": [
          "running",
          "idle",
          "ended",
        ],
        "SURFACES": [
          "desktop",
          "cli",
        ],
      }
    `);
  });
});

describe("mesaj şekilleri (alan adı/tip/sınır)", () => {
  it("SessionRegistration + her SessionEvent varyantı + her ControlCommand", () => {
    expect({
      registration: shape(relay.SessionRegistrationSchema),
      approvalRequest: shape(relay.ApprovalRequestEventSchema),
      agentTurn: shape(relay.AgentTurnEventSchema),
      output: shape(relay.OutputEventSchema),
      audit: shape(relay.AuditEventSchema),
      status: shape(relay.StatusEventSchema),
      panelSnapshot: shape(relay.PanelSnapshotEventSchema),
      steer: shape(relay.SteerCommandSchema),
      approve: shape(relay.ApproveCommandSchema),
      reject: shape(relay.RejectCommandSchema),
      kill: shape(relay.KillCommandSchema),
    }).toMatchInlineSnapshot(`
      {
        "agentTurn": {
          "props": {
            "summary": {
              "maxLength": 4000,
              "minLength": 1,
              "type": "string",
            },
            "type": {
              "const": "agent-turn",
              "type": "string",
            },
          },
          "required": [
            "summary",
            "type",
          ],
          "type": "object",
        },
        "approvalRequest": {
          "props": {
            "actionId": {
              "maxLength": 200,
              "minLength": 1,
              "type": "string",
            },
            "dialogText": {
              "maxLength": 4000,
              "minLength": 1,
              "type": "string",
            },
            "kind": {
              "maxLength": 120,
              "minLength": 1,
              "type": "string",
            },
            "type": {
              "const": "approval-request",
              "type": "string",
            },
          },
          "required": [
            "actionId",
            "dialogText",
            "kind",
            "type",
          ],
          "type": "object",
        },
        "approve": {
          "props": {
            "actionId": {
              "maxLength": 200,
              "minLength": 1,
              "type": "string",
            },
            "type": {
              "const": "approve",
              "type": "string",
            },
          },
          "required": [
            "actionId",
            "type",
          ],
          "type": "object",
        },
        "audit": {
          "props": {
            "summary": {
              "maxLength": 4000,
              "minLength": 1,
              "type": "string",
            },
            "type": {
              "const": "audit",
              "type": "string",
            },
          },
          "required": [
            "summary",
            "type",
          ],
          "type": "object",
        },
        "kill": {
          "props": {
            "type": {
              "const": "kill",
              "type": "string",
            },
          },
          "required": [
            "type",
          ],
          "type": "object",
        },
        "output": {
          "props": {
            "textB64": {
              "maxLength": 200000,
              "minLength": 1,
              "type": "string",
            },
            "type": {
              "const": "output",
              "type": "string",
            },
          },
          "required": [
            "textB64",
            "type",
          ],
          "type": "object",
        },
        "panelSnapshot": {
          "props": {
            "agents": {
              "items": {
                "props": {
                  "effort": {
                    "anyOf": [
                      {
                        "enum": [
                          "none",
                          "low",
                          "medium",
                          "high",
                          "max",
                        ],
                        "type": "string",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "id": {
                    "maxLength": 200,
                    "minLength": 1,
                    "type": "string",
                  },
                  "managerId": {
                    "anyOf": [
                      {
                        "maxLength": 200,
                        "minLength": 1,
                        "type": "string",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "model": {
                    "anyOf": [
                      {
                        "maxLength": 200,
                        "minLength": 1,
                        "type": "string",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "name": {
                    "maxLength": 80,
                    "minLength": 1,
                    "type": "string",
                  },
                  "role": {
                    "maxLength": 80,
                    "minLength": 1,
                    "type": "string",
                  },
                  "runsThisMonth": {
                    "maximum": 1000000,
                    "minimum": 0,
                    "type": "integer",
                  },
                  "status": {
                    "enum": [
                      "idle",
                      "running",
                      "waiting",
                      "error",
                      "paused",
                    ],
                    "type": "string",
                  },
                },
                "required": [
                  "effort",
                  "id",
                  "managerId",
                  "model",
                  "name",
                  "role",
                  "runsThisMonth",
                  "status",
                ],
                "type": "object",
              },
              "maxItems": 50,
              "type": "array",
            },
            "company": {
              "props": {
                "name": {
                  "maxLength": 120,
                  "minLength": 1,
                  "type": "string",
                },
              },
              "required": [
                "name",
              ],
              "type": "object",
            },
            "month": {
              "props": {
                "inputTokens": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer",
                },
                "outputTokens": {
                  "maximum": 9007199254740991,
                  "minimum": 0,
                  "type": "integer",
                },
              },
              "required": [
                "inputTokens",
                "outputTokens",
              ],
              "type": "object",
            },
            "routines": {
              "items": {
                "props": {
                  "agentId": {
                    "maxLength": 200,
                    "minLength": 1,
                    "type": "string",
                  },
                  "id": {
                    "maxLength": 200,
                    "minLength": 1,
                    "type": "string",
                  },
                  "lastOutcome": {
                    "anyOf": [
                      {
                        "maxLength": 40,
                        "minLength": 1,
                        "type": "string",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                  "name": {
                    "maxLength": 120,
                    "minLength": 1,
                    "type": "string",
                  },
                  "nextFireAt": {
                    "anyOf": [
                      {
                        "format": "date-time",
                        "type": "string",
                      },
                      {
                        "type": "null",
                      },
                    ],
                  },
                },
                "required": [
                  "agentId",
                  "id",
                  "lastOutcome",
                  "name",
                  "nextFireAt",
                ],
                "type": "object",
              },
              "maxItems": 50,
              "type": "array",
            },
            "type": {
              "const": "panel-snapshot",
              "type": "string",
            },
          },
          "required": [
            "agents",
            "company",
            "month",
            "routines",
            "type",
          ],
          "type": "object",
        },
        "registration": {
          "props": {
            "cwd": {
              "maxLength": 1024,
              "minLength": 1,
              "type": "string",
            },
            "label": {
              "maxLength": 200,
              "minLength": 1,
              "type": "string",
            },
            "surface": {
              "enum": [
                "desktop",
                "cli",
              ],
              "type": "string",
            },
          },
          "required": [
            "surface",
          ],
          "type": "object",
        },
        "reject": {
          "props": {
            "actionId": {
              "maxLength": 200,
              "minLength": 1,
              "type": "string",
            },
            "type": {
              "const": "reject",
              "type": "string",
            },
          },
          "required": [
            "actionId",
            "type",
          ],
          "type": "object",
        },
        "status": {
          "props": {
            "state": {
              "enum": [
                "running",
                "idle",
                "ended",
              ],
              "type": "string",
            },
            "type": {
              "const": "status",
              "type": "string",
            },
          },
          "required": [
            "state",
            "type",
          ],
          "type": "object",
        },
        "steer": {
          "props": {
            "message": {
              "maxLength": 4000,
              "minLength": 1,
              "type": "string",
            },
            "type": {
              "const": "steer",
              "type": "string",
            },
          },
          "required": [
            "message",
            "type",
          ],
          "type": "object",
        },
      }
    `);
  });

  it("birleşimlerin üyeleri ve ayırıcı alan `type`", () => {
    const types = (u: z.ZodType) => (z.toJSONSchema(u, { io: "input" }) as any).oneOf.map((m: any) => m.properties.type.const);
    expect(types(relay.SessionEventInputSchema)).toEqual(["approval-request", "agent-turn", "output", "audit", "status", "panel-snapshot"]);
    expect(types(relay.ControlCommandSchema)).toEqual(["steer", "approve", "reject", "kill"]);
  });
});

describe("tel örnekleri (tüketicinin gönderdiği/aldığı yük) geçerli ve geri dönüşümlü", () => {
  const events: unknown[] = [
    { type: "approval-request", actionId: "a-1", kind: "shell.exec", dialogText: "Run ls?" },
    { type: "agent-turn", summary: "did a thing" },
    { type: "output", textB64: Buffer.from("hello").toString("base64") },
    { type: "audit", summary: "ledger line" },
    { type: "status", state: "running" },
    {
      type: "panel-snapshot", company: { name: "Co" },
      agents: [{ id: "ag1", name: "CEO", role: "lead", managerId: null, model: null, effort: null, status: "idle", runsThisMonth: 0 }],
      routines: [{ id: "r1", name: "Daily", agentId: "ag1", nextFireAt: "2026-11-14T10:00:00.000Z", lastOutcome: null }],
      month: { inputTokens: 1, outputTokens: 2 },
    },
  ];
  const commands: unknown[] = [
    { type: "steer", message: "go left" },
    { type: "approve", actionId: "a-1" },
    { type: "reject", actionId: "a-1" },
    { type: "kill" },
  ];

  it.each(events.map((e) => [(e as any).type, e]))("SessionEvent %s", (_t, e) => {
    const parsed = relay.SessionEventInputSchema.parse(e);
    expect(parsed).toEqual(e);
    expect(relay.redactSessionEventInput(parsed).type).toBe((e as any).type);
  });

  it.each(commands.map((c) => [(c as any).type, c]))("ControlCommand %s", (_t, c) => {
    expect(relay.ControlCommandSchema.parse(c)).toEqual(c);
    expect(relay.redactControlCommand(c as any).type).toBe((c as any).type);
  });

  it("bilinmeyen tür / eksik alan / sınır aşımı reddedilir; yüzey yalnız desktop|cli", () => {
    expect(relay.SessionEventInputSchema.safeParse({ type: "nope" }).success).toBe(false);
    expect(relay.ControlCommandSchema.safeParse({ type: "approve" }).success).toBe(false);
    expect(relay.ControlCommandSchema.safeParse({ type: "steer", message: "x".repeat(relay.MAX_TEXT_LEN + 1) }).success).toBe(false);
    expect(relay.SessionRegistrationSchema.safeParse({ surface: "mobile" }).success).toBe(false);
    expect(relay.SessionRegistrationSchema.safeParse({ surface: "desktop" }).success).toBe(true);
  });

  it("round-trip kimlikleri bozulmaz (actionId UUID/hex), serbest metin sır maskelenir", () => {
    const id = "0123456789abcdef0123456789abcdef01234567";
    expect(relay.redactControlCommand({ type: "approve", actionId: id })).toEqual({ type: "approve", actionId: id });
    expect(relay.redact("key sk-abcdefghijklmnop end")).toBe("key «redacted» end");
  });

  it("opt-in: panel-snapshot yalnız include ile teslim edilir (eski uygulamalar almaz)", () => {
    expect(relay.deliverableTo({ type: "panel-snapshot" }, relay.parseIncludedEventTypes(undefined))).toBe(false);
    expect(relay.deliverableTo({ type: "panel-snapshot" }, relay.parseIncludedEventTypes("panel-snapshot"))).toBe(true);
    expect(relay.deliverableTo({ type: "status" }, new Set())).toBe(true);
  });
});
