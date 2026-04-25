"use client";

export default function TermsPage() {
  return (
    <div className="min-h-screen" style={{ background: "#0a0d14" }}>
      <nav className="flex items-center justify-between px-6 md:px-10 py-5 max-w-[1100px] mx-auto"
        style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
        <a href="/" className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #00d1ff, #6d11ad)" }}>
            <span className="text-white font-bold text-xs">AI</span>
          </div>
          <span className="font-headline font-bold text-sm" style={{ color: "#e1e2eb" }}>Braavolabs</span>
        </a>
        <a href="/" className="text-sm hover:text-white transition-colors" style={{ color: "#859399" }}>← Back</a>
      </nav>

      <div className="max-w-[720px] mx-auto px-6 py-16">
        <div className="mb-10">
          <h1 className="font-headline font-extrabold mb-2" style={{ fontSize: "2rem", color: "#e1e2eb" }}>Terms of Service</h1>
          <p className="text-sm" style={{ color: "#3c494e" }}>Last updated: March 2026</p>
        </div>

        <div className="space-y-8 text-sm leading-relaxed" style={{ color: "#859399" }}>
          {[
            { title: "1. Acceptance", body: "By creating an account or using Braavolabs, you agree to these Terms of Service. If you are using the platform on behalf of an organization, you represent that you have authority to bind that organization to these terms." },
            { title: "2. Service Description", body: "Braavolabs provides an AI-powered platform for creating and operating autonomous business workflows. The platform uses Claude (Anthropic) to generate agents and pipelines based on your descriptions." },
            { title: "3. Acceptable Use", body: "You may not use the platform to generate spam, conduct illegal activities, violate third-party rights, or circumvent the platform's governance and risk controls. Automated outreach is subject to anti-spam limits built into the platform." },
            { title: "4. Free Plan", body: "The free plan includes 1 company, 10 runs per month, and access to TikTok and LinkedIn channels. Free plan features may change with 30 days' notice." },
            { title: "5. Paid Plans", body: "Paid subscriptions are billed monthly via Stripe. You may cancel at any time; cancellation takes effect at the end of the current billing period. No refunds are issued for partial months." },
            { title: "6. Data Ownership", body: "You own all data you input into the platform, including company descriptions, agent configurations, and outputs. You grant us a limited license to process this data solely to provide the service." },
            { title: "7. AI Outputs", body: "AI-generated content (agent outputs, drafts, outreach messages) must be reviewed before sending. You are responsible for all content sent through integrations connected to your account." },
            { title: "8. Limitation of Liability", body: "The platform is provided 'as is'. We are not liable for indirect, incidental, or consequential damages arising from your use of the platform or AI-generated content." },
            { title: "9. Termination", body: "We may suspend or terminate accounts that violate these terms. You may delete your account at any time from the Settings page." },
            { title: "10. Contact", body: "Questions about these terms? Email us at legal@braavolabs.com." },
          ].map((section) => (
            <div key={section.title}>
              <h2 className="font-headline font-semibold text-sm mb-2" style={{ color: "#e1e2eb" }}>{section.title}</h2>
              <p>{section.body}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
