export default function SettingsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Settings</h1>
      <div className="space-y-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Workspace</h2>
          <p className="text-gray-500 text-sm">Workspace settings coming soon.</p>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Integrations</h2>
          <p className="text-gray-500 text-sm">HubSpot, Stripe, Social connections.</p>
        </div>
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold mb-4">Billing</h2>
          <p className="text-gray-500 text-sm">Plan and usage management.</p>
        </div>
      </div>
    </div>
  );
}
