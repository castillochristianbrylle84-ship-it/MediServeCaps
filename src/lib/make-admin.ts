import { getAuth } from "firebase-admin/auth";
import { initializeApp, applicationDefault } from "firebase-admin/app";

initializeApp({
  credential: applicationDefault(),
});

const uid = "rlayKF6vJUYZBK63lYpyC3QV59i2";

async function makeAdmin() {
  await getAuth().setCustomUserClaims(uid, {
    admin: true,
  });

  console.log("Admin claim successfully added.");
}

makeAdmin().catch(console.error);