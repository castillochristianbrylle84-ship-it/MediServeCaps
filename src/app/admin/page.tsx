'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AdminApp from '@/components/AdminApp';
import { auth } from '@/lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';

// Add your admin email address here
const ADMIN_EMAILS = ['adminmediserve@gmail.com'];

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user) {
        router.replace('/customer');
        return;
      }

      // Check if logged-in user's email matches your admin email list
      if (user.email && ADMIN_EMAILS.includes(user.email)) {
        setAuthorized(true);
      } else {
        router.replace('/customer');
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, [router]);

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <p className="text-gray-600">Verifying access...</p>
      </div>
    );
  }

  return authorized ? <AdminApp /> : null;
}