// Twilio over plain fetch. Without credentials, Porchlight runs in demo mode:
// every message is still recorded in the outbox, just not sent.

export interface SmsEnv {
	TWILIO_ACCOUNT_SID?: string;
	TWILIO_AUTH_TOKEN?: string;
	/** Either a sending number in E.164 form... */
	TWILIO_FROM_NUMBER?: string;
	/** ...or a Messaging Service SID. */
	TWILIO_MESSAGING_SERVICE_SID?: string;
}

export function smsLive(env: SmsEnv): boolean {
	return Boolean(
		env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID),
	);
}

export type SendResult = { status: "sent" | "demo" | "failed"; error: string };

export async function sendSms(env: SmsEnv, to: string, body: string): Promise<SendResult> {
	if (!smsLive(env)) return { status: "demo", error: "" };
	const form = new URLSearchParams({ To: to, Body: body });
	if (env.TWILIO_MESSAGING_SERVICE_SID) form.set("MessagingServiceSid", env.TWILIO_MESSAGING_SERVICE_SID);
	else form.set("From", env.TWILIO_FROM_NUMBER!);
	try {
		const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
			method: "POST",
			headers: {
				Authorization: "Basic " + btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`),
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: form,
		});
		if (res.ok) return { status: "sent", error: "" };
		const data = (await res.json().catch(() => ({}))) as { message?: string };
		return { status: "failed", error: data.message ?? `Twilio HTTP ${res.status}` };
	} catch (e) {
		return { status: "failed", error: String(e) };
	}
}

/** Best-effort E.164. Ten digits are assumed to be a US number. */
export function normalizePhone(raw: string): string | null {
	const trimmed = raw.trim();
	const digits = trimmed.replace(/\D/g, "");
	if (trimmed.startsWith("+") && digits.length >= 8 && digits.length <= 15) return "+" + digits;
	if (digits.length === 10) return "+1" + digits;
	if (digits.length === 11 && digits.startsWith("1")) return "+" + digits;
	return null;
}
