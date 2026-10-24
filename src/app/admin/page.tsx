'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AdminApp from '@/components/AdminApp';
import { auth } from '@/lib/firebase';
import { onAuthStateChanged } from 'firebase/auth';

const ADMIN_EMAILS = ['adminmediserve@gmail.com'];

export default function AdminPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      // 1. Check if user exists and email is authorized
      if (user && user.email && ADMIN_EMAILS.includes(user.email)) {
        setAuthorized(true);
      } else {
        setAuthorized(false);
        // 2. Only redirect AFTER we know for sure they are not authorized or logged in
        router.replace('/customer');
      }
      
      // 3. Stop loading once auth check is complete
      setLoading(false);
    });

    return () => unsubscribe();
  }, [router]);

  if (loading) {
    return (
      <div className="flex h-screen w-full items-center justify-center">
        <p className="text-gray-600 font-medium">Verifying access...</p>
      </div>
    );
  }

  return authorized ? <AdminApp /> : null;
}