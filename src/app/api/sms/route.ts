import { normalizePhilippinePhoneNumber, sendSMSNotification } from "@/lib/sms"; 
import * as smsOtp from "@/lib/sms-otp";
import { apiJson, handleApiOptions, isAllowedApiOrigin, requireAdmin } from "@/lib/api-security"; 
 
export const runtime = "nodejs"; 
 
export function OPTIONS(request: Request) { 
  return handleApiOptions(request); 
} 
 
export async function POST(request: Request) { 
  if (!isAllowedApiOrigin(request)) return apiJson(request, { error: "Origin not allowed." }, 403); 
  const authError = await requireAdmin(request); 
  if (authError) return authError; 
 
  try { 
    const body: unknown = await request.json(); 
    if (!body || typeof body !== "object") { 
      return apiJson(request, { error: "Phone number and message are required." }, 400); 
    } 
 
    const input = body as { phoneNumber?: unknown; message?: unknown }; 
    if (typeof input.phoneNumber !== "string" || typeof input.message !== "string") { 
      return apiJson(request, { error: "Phone number and message are required." }, 400); 
    } 
 
    const phoneNumber = normalizePhilippinePhoneNumber(input.phoneNumber); 
    if (!phoneNumber) { 
      return apiJson(request, { error: "Enter a valid Philippine mobile number." }, 400); 
    } 
    if (!input.message.trim() || input.message.length > 1000) { 
      return apiJson(request, { error: "Message must contain 1 to 1000 characters." }, 400); 
    } 
 
    const reserveNotification = (smsOtp as any).reserveNotification ??
      (smsOtp as any).reserveOtpNotification ??
      (smsOtp as any).reserveOTPNotification ??
      (smsOtp as any).reserveSMSNotification;

    const retryAfterSeconds = typeof reserveNotification === "function" ? await reserveNotification(phoneNumber) : 0;
    if (retryAfterSeconds) {
      return apiJson(request, { error: "A message was sent to this number recently.", retryAfterSeconds }, 429);
    } 
 
    await sendSMSNotification(phoneNumber, input.message.trim()); 
    return apiJson(request, { success: true }); 
  } catch (error) { 
    console.error("SMS notification failed:", error); 
    return apiJson(request, { error: "Could not send the SMS notification." }, 502); 
  } 
}