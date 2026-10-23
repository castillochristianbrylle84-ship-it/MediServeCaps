import { getAdminAuth } from "@/lib/firebase-admin";

export const runtime = "nodejs";

export async function POST() {
  try {
    const uid = "rlayKF6vJUYZBK63lYpyC3QV59i2";

    await getAdminAuth().setCustomUserClaims(uid, {
      admin: true,
    });

    return Response.json({
      success: true,
      uid,
      message: "Admin claim added successfully.",
    });
  } catch (error) {
    console.error("SET ADMIN CLAIM ERROR:", error);

    return Response.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}