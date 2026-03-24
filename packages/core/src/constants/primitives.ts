import type { Primitive } from "../types/company";

export interface PrimitiveDef {
  id: Primitive;
  name: string;
  description: string;
  defaultTools: string[];
}

export const PRIMITIVES: PrimitiveDef[] = [
  {
    id: "ACQUISITION",
    name: "Acquisition",
    description: "Lead generation, outreach, prospecting",
    defaultTools: ["find_leads", "enrich_contact", "create_outreach"],
  },
  {
    id: "SALES",
    name: "Sales",
    description: "Deal management, follow-ups, closing",
    defaultTools: ["create_deal", "update_deal_stage", "send_proposal"],
  },
  {
    id: "DELIVERY",
    name: "Delivery",
    description: "Service/product delivery, fulfillment",
    defaultTools: ["create_deliverable", "update_status", "notify_client"],
  },
  {
    id: "CONTENT",
    name: "Content",
    description: "Content creation, scheduling, publishing",
    defaultTools: ["generate_post", "create_draft", "schedule_content", "analyze_trends"],
  },
  {
    id: "OPERATIONS",
    name: "Operations",
    description: "Internal workflows, task management",
    defaultTools: ["create_task", "assign_task", "update_workflow"],
  },
  {
    id: "FINANCE",
    name: "Finance",
    description: "Invoicing, expense tracking, revenue",
    defaultTools: ["create_invoice", "track_expense", "generate_report"],
  },
  {
    id: "ANALYTICS",
    name: "Analytics",
    description: "Metrics, reporting, insights",
    defaultTools: ["fetch_metrics", "generate_report", "compare_performance"],
  },
  {
    id: "MEMORY",
    name: "Memory",
    description: "Learning, knowledge retention, pattern recognition",
    defaultTools: ["store_memory", "recall_memory", "consolidate_memories"],
  },
  {
    id: "GOVERNANCE",
    name: "Governance",
    description: "Risk detection, safety, compliance",
    defaultTools: ["check_risk", "enforce_policy", "audit_action"],
  },
];
