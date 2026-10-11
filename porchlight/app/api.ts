import type { AdminCircle, Card, Light, PlannedMessage, PublicCircle, WorkCard, WorkView } from "../shared";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`/api/porchlight${path}`, {
		method,
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as { error?: string };
	if (!res.ok) throw new Error(data.error ?? "Something went wrong. Please try again.");
	return data as T;
}

export interface NewCircle {
	grieverName: string;
	lovedOneName: string;
	relationship: string;
	lossDate: string;
	grieverPhone: string;
	sponsor: string;
	timezone: string;
}

export const api = {
	createCircle: (b: NewCircle) => call<{ adminToken: string; joinCode: string }>("POST", "/circles", b),
	admin: (t: string) => call<AdminCircle>("GET", `/g/${t}`),
	setLight: (t: string, light: Light, note: string, quiet: boolean) =>
		call<AdminCircle>("PUT", `/g/${t}/light`, { light, note, quiet }),
	saveCard: (t: string, card: Card) => call<AdminCircle>("PUT", `/g/${t}/card`, card),
	saveProfile: (t: string, b: Omit<NewCircle, "timezone"> & { timezone: string }) =>
		call<AdminCircle>("PUT", `/g/${t}/profile`, b),
	saveWork: (t: string, work: WorkCard) => call<AdminCircle>("PUT", `/g/${t}/work`, work),
	stepAway: (t: string) => call<{ ok: boolean; alreadySent: boolean }>("POST", `/g/${t}/step-away`),
	removeSupporter: (t: string, id: string) => call<AdminCircle>("DELETE", `/g/${t}/supporters/${id}`),
	preview: (t: string, date: string) =>
		call<{ date: string; messages: PlannedMessage[] }>("GET", `/g/${t}/preview?date=${date}`),
	circle: (code: string) => call<PublicCircle>("GET", `/c/${code}`),
	join: (code: string, b: { name: string; phone: string; relationship: string; consent: boolean }) =>
		call<{ supporterToken: string; rejoined: boolean }>("POST", `/c/${code}/join`, b),
	supporter: (t: string) => call<{ name: string; active: boolean }>("GET", `/s/${t}`),
	leave: (t: string) => call<{ ok: boolean }>("POST", `/s/${t}/leave`),
	work: (code: string) => call<WorkView>("GET", `/w/${code}`),
};

/** localStorage that never throws (private windows, blocked storage). */
export const store = {
	get(key: string): string | null {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	set(key: string, value: string | null) {
		try {
			if (value === null) localStorage.removeItem(key);
			else localStorage.setItem(key, value);
		} catch {
			/* ignore */
		}
	},
};
