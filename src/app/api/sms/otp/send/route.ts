import { normalizePhilippinePhoneNumber, sendVerificationOtp } from "@/lib/sms"; 
import * as smsOtp from "@/lib/sms-otp";
import { apiJson, handleApiOptions, isAllowedApiOrigin } from "@/lib/api-security"; 

const otpService = smsOtp as typeof smsOtp & {
  discardOtp?: (phoneNumber: string, code: string) => Promise<void>;
};

export const runtime = "nodejs"; 
 
function logOtpException(error: unknown) { 
  if (error instanceof Error) { 
    console.error("OTP Service Exception:", { 
      name: error.name, 
      message: error.message, 
      stack: error.stack, 
    }); 
  } else { 
    console.error("OTP Service Exception:", error); 
  } 
} 
 
export function OPTIONS(request: Request) { 
  return handleApiOptions(request); 
} 
 
export async function POST(request: Request) { 
  if (!isAllowedApiOrigin(request)) return apiJson(request, { error: "Origin not allowed." }, 403); 
 
  try { 
    if (!process.env.IPROGSMS_API_KEY) {
      return apiJson(
        request,
        { error: "SMS delivery is not configured. Add IPROGSMS_API_KEY to the server environment." },
        503
      );
    }

    const body: unknown = await request.json(); 
    if (!body || typeof body !== "object" || !("phoneNumber" in body)) { 
      return apiJson(request, { error: "Phone number is required." }, 400); 
    } 
 
    const phoneNumber = (body as { phoneNumber?: unknown }).phoneNumber; 
    if (typeof phoneNumber !== "string") { 
      return apiJson(request, { error: "Phone number is invalid." }, 400); 
    } 
    const normalizedNumber = normalizePhilippinePhoneNumber(phoneNumber); 
    if (!normalizedNumber) { 
      return apiJson(request, { error: "Use a Philippine mobile number such as 09171234567 or +639171234567." }, 400); 
    } 
 
    const challenge = await otpService.issueOtp(normalizedNumber);
    const challengeWithRetry = challenge as typeof challenge & { retryAfterSeconds?: number };
    if (challengeWithRetry.retryAfterSeconds) {
      return apiJson(request, {
        error: "Please wait before requesting another code.",
        retryAfterSeconds: challengeWithRetry.retryAfterSeconds,
      }, 429);
    }

    try {
      await sendVerificationOtp(normalizedNumber, challenge.code!);
    } catch (error) {
      logOtpException(error);
      try {
        await otpService.discardOtp?.(normalizedNumber, challenge.code!);
      } catch (cleanupError) {
        logOtpException(cleanupError);
      }
      return apiJson(request, { error: "Failed to contact the SMS gateway." }, 502);
    }
 
    return apiJson(request, { success: true, expiresInSeconds: 300 }); 
} catch (error) {
  logOtpException(error);
  return apiJson(request, { error: "Could not send a verification code." }, 500);
}
}