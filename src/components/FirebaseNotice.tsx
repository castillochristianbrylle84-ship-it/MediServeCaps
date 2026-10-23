"use client";

export default function FirebaseNotice({ error }: { error: string }) {
  return (
    <div className="min-h-screen bg-amber-50 flex items-center justify-center p-6">
      <div className="max-w-lg w-full bg-white rounded-3xl shadow-xl border border-amber-200 p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-12 h-12 bg-amber-100 rounded-2xl flex items-center justify-center text-2xl">🔥</div>
          <div>
            <h1 className="text-xl font-bold text-gray-900">Firebase Setup Required</h1>
            <p className="text-sm text-gray-500">Configure your Firebase project to continue</p>
          </div>
        </div>

        <div className="bg-red-50 border border-red-200 rounded-xl p-4 mb-6">
          <p className="text-sm font-semibold text-red-800 mb-1">Connection Error</p>
          <p className="text-xs text-red-700 font-mono break-all">{error}</p>
        </div>

        <div className="space-y-4 text-sm text-gray-700">
          <p className="font-semibold">Quick Setup Steps:</p>
          <ol className="space-y-3 list-decimal list-inside">
            <li>Go to <a href="https://console.firebase.google.com" target="_blank" rel="noreferrer" className="text-emerald-700 underline font-medium">console.firebase.google.com</a></li>
            <li>Create a new project named <code className="bg-gray-100 px-1.5 py-0.5 rounded">mediserve</code></li>
            <li>Enable <strong>Firestore</strong> and <strong>Authentication → Email/Password</strong></li>
            <li>Add an admin user in Authentication → Users</li>
            <li>Copy your web app config and update the <code className="bg-gray-100 px-1.5 py-0.5 rounded">.env</code> file</li>
          </ol>
        </div>

        <div className="mt-6 p-4 bg-gray-50 rounded-xl">
          <p className="text-xs font-semibold text-gray-600 mb-2">Required .env variables:</p>
          <pre className="text-xs text-gray-800 overflow-auto">
{`NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=...
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=...
NEXT_PUBLIC_FIREBASE_APP_ID=...`}
          </pre>
        </div>

        <p className="mt-4 text-xs text-gray-400 text-center">See <code>FIREBASE_SETUP.md</code> for detailed instructions</p>
      </div>
    </div>
  );
}
