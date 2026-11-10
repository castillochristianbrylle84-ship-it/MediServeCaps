import "server-only";

import { getAuth } from "firebase-admin/auth";
import { getSmsAdminApp } from "@/lib/sms-admin";

function allowedOrigins(): string[] {
  return (process.env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .map((origin) => {
      try {
        const parsed = new URL(origin);

        if (
          !["http:", "https:"].includes(
            parsed.protocol
          ) ||
          parsed.pathname !== "/" ||
          parsed.search ||
          parsed.hash
        ) {
          return null;
        }

        return parsed.origin;
      } catch {
        return null;
      }
    })
    .filter(
      (origin): origin is string =>
        origin !== null
    );
}

export function isAllowedApiOrigin(
  request: Request
): boolean {
  const origin =
    request.headers.get("origin");

  if (!origin) return true;

  if (
    origin === new URL(request.url).origin
  ) {
    return true;
  }

  return allowedOrigins().includes(origin);
}

function corsHeaders(
  request: Request
): Headers {
  const headers = new Headers({
    Vary: "Origin",
    "Access-Control-Allow-Methods":
      "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
  });

  const origin =
    request.headers.get("origin");

  if (
    origin &&
    isAllowedApiOrigin(request)
  ) {
    headers.set(
      "Access-Control-Allow-Origin",
      origin
    );
  }

  return headers;
}

export function apiJson(
  request: Request,
  body: unknown,
  status = 200
): Response {
  return Response.json(body, {
    status,
    headers: corsHeaders(request),
  });
}

export function handleApiOptions(
  request: Request
): Response {
  return new Response(null, {
    status: isAllowedApiOrigin(request)
      ? 204
      : 403,
    headers: corsHeaders(request),
  });
}

export async function requireAdmin(
  request: Request
): Promise<Response | null> {
  const authorization =
    request.headers.get("authorization");

  const match =
    authorization?.match(
      /^Bearer\s+(.+)$/i
    );

  if (!match) {
    return apiJson(
      request,
      {
        error:
          "Authentication required.",
      },
      401
    );
  }

  try {
    const auth = getAuth(getSmsAdminApp());
    const decodedToken = await auth.verifyIdToken(match[1], true);
    const user = await auth.getUser(decodedToken.uid);
    const customClaims = user.customClaims ?? {};

    if (
      customClaims.admin !== true &&
      customClaims.role !== "admin"
    ) {
      return apiJson(
        request,
        {
          error:
            "Admin access required.",
        },
        403
      );
    }

    return null;
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith(
        "FIREBASE_ADMIN_"
      )
    ) {
      console.error(
        "Admin authentication is not configured:",
        error
      );

      return apiJson(
        request,
        {
          error:
            "Admin authentication is not configured.",
        },
        500
      );
    }

    const invalidTokenCodes = new Set([
      "auth/argument-error",
      "auth/id-token-expired",
      "auth/id-token-revoked",
      "auth/invalid-id-token",
      "auth/user-disabled",
      "auth/user-not-found",
    ]);

    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      invalidTokenCodes.has(error.code)
    ) {
      return apiJson(
        request,
        { error: "Invalid or expired authentication token." },
        401
      );
    }

    console.error("Could not verify admin authorization:", error);
    return apiJson(
      request,
      { error: "Could not verify admin authorization." },
      500
    );
  }
}