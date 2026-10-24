'use client';

import { useEffect, useState } from 'react';
import AdminApp from '@/components/AdminApp';
import { auth } from '@/lib/firebase';
import { onAuthStateChanged, User } from 'firebase/auth';

const ADMIN_EMAILS = ['adminmediserve@gmail.com'];

export default function AdminPage() {
  const [loading, setLoading] = useState(true);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
      if (user && user.email && ADMIN_EMAILS.includes(user.email)) {
        setAuthorized(true);
      } else {
        setAuthorized(false);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <p className="text-gray-600 font-medium">Verifying access...</p>
      </div>
    );
  }

  // IF AUTHORIZED, SHOW ADMIN APP
  if (authorized) {
    return <AdminApp />;
  }

  // IF NOT AUTHORIZED, SHOW US WHY ON THE SCREEN INSTEAD OF REDIRECTING
  return (
    <div style={{ padding: '40px', fontFamily: 'sans-serif', maxWidth: '600px', margin: '0 auto' }}>
      <h2 style={{ color: 'red' }}>Access Denied / Not Logged In</h2>
      <p><strong>Current logged-in user:</strong> {currentUser ? currentUser.email : 'No user logged in (null)'}</p>
      <p><strong>Expected Admin Email:</strong> {ADMIN_EMAILS[0]}</p>
      <hr style={{ margin: '20px 0' }} />
      <p>To fix this:</p>
      <ol>
        <li>Go to <a href="/customer" style={{ color: 'blue', textDecoration: 'underline' }}>/customer</a> and log in using <code>{ADMIN_EMAILS[0]}</code>.</li>
        <li>Come back to this page.</li>
      </ol>
    </div>
  );
}