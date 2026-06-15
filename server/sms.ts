type SendSmsResult = {
  configured: boolean;
  ok: boolean;
  message: string;
  messageId?: string;
  provider?: string;
};

const iprogEndpoint = "https://sms.iprogtech.com/api/v1/sms_messages";

export function isSmsConfigured() {
  return Boolean(process.env.IPROG_SMS_API_TOKEN);
}

export function normalizeSmsPhone(phone: string) {
  const clean = String(phone || "").trim().replace(/\s+/g, "");
  if (/^\+639\d{9}$/.test(clean)) return clean.slice(1);
  if (/^639\d{9}$/.test(clean)) return clean;
  if (/^09\d{9}$/.test(clean)) return `63${clean.slice(1)}`;
  return clean;
}

export async function sendSms(phone: string, message: string): Promise<SendSmsResult> {
  const apiToken = process.env.IPROG_SMS_API_TOKEN;
  if (!apiToken) {
    return {
      configured: false,
      ok: false,
      message: "IPROG_SMS_API_TOKEN is not configured."
    };
  }

  const phoneNumber = normalizeSmsPhone(phone);
  if (!/^639\d{9}$/.test(phoneNumber)) {
    return {
      configured: true,
      ok: false,
      message: "Invalid Philippine phone number."
    };
  }

  const configuredProvider = process.env.IPROG_SMS_PROVIDER;
  const providers =
    configuredProvider && configuredProvider !== "auto"
      ? [configuredProvider]
      : ["0", "1", "2"];

  try {
    let lastResult: SendSmsResult = {
      configured: true,
      ok: false,
      message: "SMS request failed."
    };

    for (const provider of providers) {
      const body = new URLSearchParams({
        api_token: apiToken,
        phone_number: phoneNumber,
        message: message.slice(0, 480),
        sms_provider: provider
      });

      const response = await fetch(`${iprogEndpoint}?${body.toString()}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      const payload = (await response.json().catch(() => ({}))) as {
        status?: number | string;
        message?: string;
        message_id?: string;
      };

      const ok = response.ok && (payload.status === 200 || payload.status === "success");
      lastResult = {
        configured: true,
        ok,
        provider,
        message: payload.message || (ok ? "SMS queued successfully." : "SMS request failed."),
        messageId: payload.message_id
      };

      if (ok) return lastResult;
    }

    if (/Smart\/TNT|shared sender/i.test(lastResult.message)) {
      return {
        ...lastResult,
        message:
          "iProgSMS blocked this number because Smart/TNT does not accept the shared sender name. Request an approved sender name in iProgSMS, or test with a Globe/TM/DITO/GOMO number."
      };
    }

    return lastResult;
  } catch (error) {
    return {
      configured: true,
      ok: false,
      message: error instanceof Error ? error.message : "Unable to reach iProgSMS."
    };
  }
}
