import "server-only";

import {
  cert,
  getApps,
  initializeApp,
  type App,
} from "firebase-admin/app";

import {
  getFirestore,
  type Firestore,
} from "firebase-admin/firestore";

export function getSmsAdminApp(): App {
  const projectId = process.env.FIREBASE_ADMIN_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_ADMIN_CLIENT_EMAIL;

  const privateKey = process.env.FIREBASE_ADMIN_PRIVATE_KEY
    ?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      "FIREBASE_ADMIN_PROJECT_ID, " +
        "FIREBASE_ADMIN_CLIENT_EMAIL, and " +
        "FIREBASE_ADMIN_PRIVATE_KEY are required."
    );
  }

  return (
    getApps().find((app) => app.name === "sms-admin") ??
    initializeApp(
      {
        credential: cert({
          projectId,
          clientEmail,
          privateKey,
        }),
      },
      "sms-admin"
    )
  );
}

export function getSmsAdminDb(): Firestore {
  return getFirestore(getSmsAdminApp());
}