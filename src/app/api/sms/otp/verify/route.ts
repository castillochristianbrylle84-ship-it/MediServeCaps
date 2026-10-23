import { normalizePhilippinePhoneNumber } from "@/lib/sms"; 
import * as smsOtp from "@/lib/sms-otp"; 
import { apiJson, handleApiOptions, isAllowedApiOrigin } from "@/lib/api-security"; 

const verifyOtp =
  (smsOtp as any).verifyOtp ??
  (smsOtp as any).verifyOTP ??
  (smsOtp as any).verifyOtpCode ??
  (smsOtp as any).verifyCode;

export const runtime = "nodejs"; 
 
export function OPTIONS(request: Request) { 
  return handleApiOptions(request); 
} 
 
export async function POST(request: Request) { 
  if (!isAllowedApiOrigin(request)) return apiJson(request, { error: "Origin not allowed." }, 403); 
 
  try { 
    const body: unknown = await request.json(); 
    if (!body || typeof body !== "object") { 
      return apiJson(request, { error: "Phone number and code are required." }, 400); 
    } 
 
    const input = body as { phoneNumber?: unknown; code?: unknown }; 
    if (typeof input.phoneNumber !== "string" || typeof input.code !== "string") { 
      return apiJson(request, { error: "Phone number and code are required." }, 400); 
    } 
    const normalizedNumber = normalizePhilippinePhoneNumber(input.phoneNumber); 
    if (!normalizedNumber || !/^\d{6}$/.test(input.code)) { 
      return apiJson(request, { error: "Phone number or code is invalid." }, 400); 
    } 
 
    const result = await verifyOtp(normalizedNumber, input.code); 
    if (result === "verified") return apiJson(request, { verified: true }); 
    if (result === "locked") { 
      return apiJson(request, { error: "Too many attempts. Request a new code." }, 429); 
    } 
    if (result === "expired") { 
      return apiJson(request, { error: "The code has expired. Request a new one." }, 410); 
    } 
    return apiJson(request, { error: "The verification code is invalid." }, 400); 
  } catch (error) { 
    console.error("OTP verification failed:", error); 
    return apiJson(request, { error: "Could not verify the code." }, 500); 
  } 
} 