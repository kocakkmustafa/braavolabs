"use client";

import { useState } from "react";
import { useAppStore } from "../../lib/store";

export default function SettingsPage() {
  const token = useAppStore((s) => s.token);
  const tenantId = useAppStore((s) => s.tenantId);
  const clearAuth = useAppStore((s) => s.clearAuth);

  if (!token) return <p className="text-gray-500">Please login first.</p>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Settings</h1>

      <div className="space-y-6">
        {/* Auth Info */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Authentication</h2>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Tenant ID</span>
              <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">{tenantId ?? "—"}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-500">Token</span>
              <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">
                {token.slice(0, 20)}...
              </span>
            </div>
            <button
              onClick={clearAuth}
              className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 text-sm mt-2"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Integrations */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Integrations</h2>
          <div className="space-y-4">
            <IntegrationRow
              name="HubSpot CRM"
              description="Sync contacts and deals bidirectionally"
              status="configured"
              envVar="HUBSPOT_ACCESS_TOKEN"
            />
            <IntegrationRow
              name="Stripe Billing"
              description="Usage-based billing and subscription management"
              status="pending"
              envVar="STRIPE_SECRET_KEY"
            />
            <IntegrationRow
              name="SendGrid Email"
              description="Transactional and outreach email delivery"
              status="configured"
              envVar="SENDGRID_API_KEY"
            />
            <IntegrationRow
              name="TikTok"
              description="Publish and analyze TikTok content"
              status="pending"
              envVar="TIKTOK_*"
            />
            <IntegrationRow
              name="LinkedIn"
              description="Publish and analyze LinkedIn content"
              status="pending"
              envVar="LINKEDIN_*"
            />
            <IntegrationRow
              name="Anthropic (Claude)"
              description="AI agent reasoning and tool use"
              status="configured"
              envVar="ANTHROPIC_API_KEY"
            />
          </div>
        </div>

        {/* Governance */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Governance Config</h2>
          <p className="text-sm text-gray-500 mb-4">
            Risk stops and safety policies. Full governance engine coming in Faz 6.
          </p>
          <div className="space-y-3 text-sm">
            <GovernanceItem label="Spend Approval Required" value="Yes (all spend actions)" />
            <GovernanceItem label="Loop Detection Threshold" value="5 consecutive failures" />
            <GovernanceItem label="Cost Anomaly Threshold" value="20% of run budget" />
            <GovernanceItem label="Spam Protection" value="3+ unanswered outreach = blocked" />
            <GovernanceItem label="Memory Auto-Promote" value="confidence >= 0.7, useCount >= 3, age >= 7d" />
            <GovernanceItem label="Memory Auto-Deprecate" value="90d unused (APPROVED), 30d + 0 uses (CANDIDATE)" />
            <GovernanceItem label="Holding Brain Requirement" value="2+ companies with same pattern" />
          </div>
        </div>

        {/* Plan */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Plan & Usage</h2>
          <p className="text-sm text-gray-500 mb-4">
            Billing management coming in Faz 5.
          </p>
          <div className="grid grid-cols-3 gap-4">
            <PlanCard
              name="Free"
              features={["1 company", "10 runs/month", "TikTok + LinkedIn", "Real outputs"]}
              current={true}
            />
            <PlanCard
              name="Pro"
              features={["5 companies", "100 runs/month", "All channels", "Priority support"]}
              current={false}
            />
            <PlanCard
              name="Enterprise"
              features={["Unlimited companies", "Unlimited runs", "Custom integrations", "SLA guarantee"]}
              current={false}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function IntegrationRow({ name, description, status, envVar }: {
  name: string; description: string; status: "configured" | "pending"; envVar: string;
}) {
  return (
    <div className="flex items-center justify-between py-2 border-b last:border-0">
      <div>
        <p className="font-medium text-sm">{name}</p>
        <p className="text-xs text-gray-500">{description}</p>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400 font-mono">{envVar}</span>
        <span className={`text-xs px-2 py-0.5 rounded-full ${
          status === "configured"
            ? "bg-green-100 text-green-800"
            : "bg-gray-100 text-gray-500"
        }`}>
          {status === "configured" ? "Configured" : "Not Connected"}
        </span>
      </div>
    </div>
  );
}

function GovernanceItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-center py-1">
      <span className="text-gray-600">{label}</span>
      <span className="font-mono text-xs bg-gray-100 px-2 py-1 rounded">{value}</span>
    </div>
  );
}

function PlanCard({ name, features, current }: {
  name: string; features: string[]; current: boolean;
}) {
  return (
    <div className={`border rounded-lg p-4 ${current ? "border-blue-500 bg-blue-50" : ""}`}>
      <h3 className="font-semibold mb-2">{name}</h3>
      {current && <span className="text-xs bg-blue-600 text-white px-2 py-0.5 rounded mb-2 inline-block">Current</span>}
      <ul className="text-xs text-gray-600 space-y-1 mt-2">
        {features.map((f) => (
          <li key={f}>- {f}</li>
        ))}
      </ul>
    </div>
  );
}
