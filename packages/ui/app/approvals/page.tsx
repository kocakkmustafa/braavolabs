export default function ApprovalsPage() {
  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">Pending Approvals</h1>
      <div className="bg-white rounded-lg shadow">
        <div className="p-6 text-center text-gray-500">
          <p>No pending approvals. Approvals are required only for spend actions.</p>
        </div>
      </div>
    </div>
  );
}
