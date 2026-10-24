'use client';

import { useEffect, useState } from 'react';
import AdminApp from '@/components/AdminApp';
import { auth } from '@/lib/firebase';
import { onAuthStateChanged, signInWithEmailAndPassword, signOut, User } from 'firebase/auth';

const ADMIN_EMAIL = 'adminmediserve@gmail.com';

export default function AdminPage() {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  
  // Form states for admin login
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  // Handle admin login form submission
  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoggingIn(true);

    try {
      // Check if email matches admin before trying to sign in
      if (email !== ADMIN_EMAIL) {
        throw new Error('Unauthorized admin email.');
      }
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err: any) {
      setError(err.message || 'Failed to log in. Check your email and password.');
    } finally {
      setLoggingIn(false);
    }
  };

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <p className="text-gray-600 font-medium">Loading admin panel...</p>
      </div>
    );
  }

  // If logged in AND is the admin email, show the Admin Panel
  if (user && user.email === ADMIN_EMAIL) {
    return (
      <div>
        {/* Optional quick logout bar at the top */}
        <div className="bg-gray-900 text-white px-4 py-2 flex justify-between items-center text-sm">
          <span>Logged in as Admin: {user.email}</span>
          <button 
            onClick={() => signOut(auth)} 
            className="bg-red-600 px-3 py-1 rounded hover:bg-red-700 transition"
          >
            Log Out
          </button>
        </div>
        <AdminApp />
      </div>
    );
  }

  // Otherwise, show a clean Admin Login Screen
  return (
    <div className="flex h-screen w-full items-center justify-center bg-gray-100">
      <div className="w-full max-w-md bg-white p-8 rounded-lg shadow-md">
        <h1 className="text-2xl font-bold mb-6 text-center text-gray-800">Admin Panel Login</h1>
        
        {error && (
          <div className="mb-4 p-3 bg-red-100 text-red-700 text-sm rounded">
            {error}
          </div>
        )}

        <form onSubmit={handleLogin} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Admin Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-black"
              placeholder="adminmediserve@gmail.com"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-black"
              placeholder="••••••••"
            />
          </div>

          <button
            type="submit"
            disabled={loggingIn}
            className="w-full py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition font-medium disabled:opacity-50"
          >
            {loggingIn ? 'Logging in...' : 'Login to Admin'}
          </button>
        </form>
      </div>
    </div>
  );
}