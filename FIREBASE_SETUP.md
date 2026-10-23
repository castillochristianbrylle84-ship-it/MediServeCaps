# 🔥 Firebase Setup Guide for MediServe

## Step 1: Create a Firebase Project

1. Go to https://console.firebase.google.com/
2. Click **"Add project"**
3. Name it `mediserve` (or any name you prefer)
4. Follow the setup wizard

---

## Step 2: Enable Authentication //

1. In Firebase Console → **Authentication** → **Get Started**
2. Go to **Sign-in method** tab
3. Enable **Email/Password**
4. Go to **Users** tab → **Add user**
5. Add your admin email & password (this is what you'll use to log in). Then assign the `admin: true` Firebase custom claim as described in [ADMIN_NETLIFY_DEPLOY.md](ADMIN_NETLIFY_DEPLOY.md); without it, the user cannot access the Admin Dashboard or protected SMS API.

---

## Step 3: Create Firestore Database //

1. In Firebase Console → **Firestore Database** → **Create database**
2. Choose **Production mode** (or Start in test mode for development)
3. Choose your region (closest to you)

### Firestore Collections (auto-created when first used):
| Collection | Purpose |
|---|---|
| `customers` | All queue patients (Customer Database) |
| `regular_patients` | Regular patient mirror |
| `pwd_patients` | PWD patient mirror |
| `orders` | Order table per queue entry |
| `stock` | Medicine & Stocks Table |

### Firestore Security Rules (paste in Rules tab):
```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Public read for stock (customers need to see medicines)
    match /stock/{id} {
      allow read: if true;
      allow write: if request.auth != null;
    }
    // Public write for customers (queue registration)
    match /customers/{id} {
      allow read, write: if true;
    }
    match /regular_patients/{id} {
      allow read, write: if true;
    }
    match /pwd_patients/{id} {
      allow read, write: if true;
    }
    match /orders/{id} {
      allow read, write: if true;
    }
  }
}
```

---

## Step 4: Get Your Firebase Config //

1. In Firebase Console → Project Settings (gear icon) → **General**
2. Scroll to **"Your apps"** → Click **Web** icon (`</>`)
3. Register app, name it `mediserve-web`
4. Copy the config values

---

## Step 5: Configure the Firebase Web App //

Use the web app config copied in Step 4. For the Next.js app, add these values to
`.env.local` at the project root:

```env
NEXT_PUBLIC_FIREBASE_API_KEY=AIzaSy...your-real-key
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
NEXT_PUBLIC_FIREBASE_PROJECT_ID=your-project-id
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=123456789
NEXT_PUBLIC_FIREBASE_APP_ID=1:123456789:web:abcdef
```

For the standalone Vite admin app, add the same values to the project-root
`.env.local` using the `VITE_` prefixes shown in `admin/.env.example`. These
values are read at build time, so restart the dev server or rebuild after
changing them. Do not use placeholder values or put service-account credentials
in these client-side variables.

For Netlify, configure the Next.js Customer/backend site's
`NEXT_PUBLIC_FIREBASE_*` values in **Site configuration → Environment
variables**. The separate static Vite Admin site uses the `VITE_FIREBASE_*`
names documented in [ADMIN_NETLIFY_DEPLOY.md](./ADMIN_NETLIFY_DEPLOY.md).
Firebase web config is public client configuration, not a server credential.
If Netlify's smart secrets scanner flags the Firebase web API key in generated
client bundles, set `SECRETS_SCAN_SMART_DETECTION_OMIT_VALUES` in Netlify's
environment-variable UI to the exact detected public key; do not commit that
value in `netlify.toml`.

---

## Step 6: Configure SMS and OTP //

1. Copy `.env.example` to `.env.local` and fill in the Firebase web config from Step 5. //
2. In Firebase Console, open **Project settings → Service accounts** and generate a private key for a dedicated service account. Set `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, and `FIREBASE_ADMIN_PRIVATE_KEY` in `.env.local`. Keep this private key server-side; never use a `NEXT_PUBLIC_` prefix for it. //
3. Create an account at [iProgSMS](https://www.iprogsms.com/), generate an API token, and configure an approved sender identity in the provider account. Set `IPROGSMS_API_KEY` in the backend environment. The token must not be exposed to browser code. // 
4. Set `OTP_HASH_SECRET` to a high-entropy random secret. For example, generate 32 random bytes with a password manager or a cryptographic random generator. Do not reuse the SMS API key. // 
5. Restart the Next.js server after changing environment variables. Rebuild the
   Vite admin app after changing its environment variables. Do not commit
   `.env.local`.

For Netlify, add all five server-side variables
(`FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`,
`FIREBASE_ADMIN_PRIVATE_KEY`, `IPROGSMS_API_KEY`, and `OTP_HASH_SECRET`) under
**Site configuration → Environment variables** for the production deploy
context of the Next.js Customer/backend site. Netlify does not read your local
`.env.local`. These values are needed at runtime by the OTP route; the Firebase
Admin values are also needed by `/api/admin/make-admin`. After adding or changing
them, trigger a new deploy. Keep these credentials server-side; never give them
a `NEXT_PUBLIC_` prefix or put them in the separate static Admin site's
environment variables. `OTP_HASH_SECRET` must contain at least 32 characters.
For `FIREBASE_ADMIN_PRIVATE_KEY`, preserve the PEM key and encode line breaks as
`\n` if entering it as a single line.

`.env.example` lists every required and optional variable. OTP documents are accessed only by the Firebase Admin SDK and the client Firestore rules should not grant access to these collections:

```text
smsOtpChallenges
smsOtpRateLimits
smsNotificationRateLimits
```

Admin SDK access bypasses Firestore rules. Do not add permissive client rules for those collections. The server stores a keyed digest rather than the plain OTP; codes expire after five minutes, verification is limited to five attempts, and OTP sends are limited to one per phone number per minute and five per hour.

Customer registration requires a one-time code sent to the entered phone number. The customer requests a code, submits it for verification, and can submit the queue form only after the code is verified for that same phone number. Admin login and actions do not use SMS/OTP verification.

### API usage

Request an OTP:

```http
POST /api/sms/otp/send
Content-Type: application/json

{"phoneNumber":"09171234567"}
```

Verify an OTP:

```http
POST /api/sms/otp/verify
Content-Type: application/json

{"phoneNumber":"+639171234567","code":"123456"}
```

The verify endpoint returns `{ "verified": true }` only when a valid, unexpired code is consumed. A code can be used once. General notifications can be sent using `POST /api/sms` with `phoneNumber` and `message`; that endpoint permits one notification per destination per minute. All endpoints accept `09XXXXXXXXX`, `+639XXXXXXXXX`, or `639XXXXXXXXX` and normalize to `+639XXXXXXXXX`.

SMS delivery uses the iProgSMS endpoint `POST https://www.iprogsms.com/api/v1/sms_messages` with required `api_token`, `phone_number`, and `message` parameters. The backend sends these in a JSON body; the optional `sms_provider` parameter defaults to `0`. `IPROGSMS_API_KEY` is read only by the server from its environment. A successful provider response contains `status: 200` and a queued message ID.

The Admin Get Ready action sends `Hello [Customer Name] (Queue [Queue Number]), your turn is coming up soon! Please prepare to be called.` through `POST /api/sms`; this route requires the Admin's Firebase ID token. SMS sending requires a funded/active iProgSMS account and a sender identity configured with the provider.

**Credential cleanup:** An SMS key was previously embedded in the source route. Rotate/revoke that key in its provider dashboard before deploying, even though the source hardcode has been removed.

---

## Database Schema Summary

### `customers` (Customer Database)
```json
{
  "id": "auto-generated",
  "queueNumber": "A042",
  "patientName": "Juan Dela Cruz",
  "address": "123 Main St",
  "phone": "+63 912 345 6789",
  "patientType": "regular | pwd",
  "medicines": ["Paracetamol", "Amoxicillin"],
  "quantities": [2, 1],
  "status": "waiting | processing | getready | served",
  "timestamp": "2025-01-01T10:00:00.000Z",
  "createdAt": "Firestore Timestamp",
  "updatedAt": "Firestore Timestamp"
}
```

### `stock` (Medicine & Stocks Table)
```json
{
  "id": "auto-generated",
  "name": "Paracetamol 500mg",
  "type": "Tablet",
  "stock": 150,
  "available": true,
  "createdAt": "Firestore Timestamp",
  "updatedAt": "Firestore Timestamp"
}
```

### `orders` (Order Table)
```json
{
  "id": "same as customer id",
  "customerId": "customer-doc-id",
  "queueNumber": "A042",
  "medicines": ["Paracetamol"],
  "quantities": [2],
  "status": "waiting",
  "patientType": "regular",
  "timestamp": "ISO string",
  "createdAt": "Firestore Timestamp",
  "updatedAt": "Firestore Timestamp"
}
```

## Daily queue rollover

Queue tickets are assigned a `queueDate` using the `Asia/Manila` timezone.
The admin and customer queue listeners show entries for the current queue date
and switch to the new date after midnight. Older tickets without `queueDate`
remain visible on the matching day based on their `createdAt` timestamp.

Vercel schedules `GET /api/reset-queue` daily at midnight in `Asia/Manila`
(16:00 UTC), as configured in `vercel.json`. The route archives the previous
day's tickets in batches, updates their `orders` and patient-type mirrors, and
rolls `queue_metadata/today` forward with fresh daily counters. Ticket numbers
are allocated server-side by `/api/queue/next-number`, using the same metadata
document to avoid a counter reset racing with a new registration.

Set a high-entropy `CRON_SECRET` environment variable in Vercel. Vercel sends
it as a bearer token to protect the reset route. The route also needs the
existing `FIREBASE_ADMIN_PROJECT_ID`, `FIREBASE_ADMIN_CLIENT_EMAIL`, and
`FIREBASE_ADMIN_PRIVATE_KEY` server-side environment variables to access
Firestore through the Admin SDK.
