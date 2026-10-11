import { useCallback, useEffect, useState } from "react";

export async function api<T = { ok: true }>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`/api/ripple${path}`, {
		method,
		credentials: "same-origin",
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error((data as { error?: string }).error ?? "Something went wrong. Please try again.");
	return data as T;
}

export const message = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong. Please try again.");

/** Loads a resource once and exposes `reload` for after a change. */
export function useLoad<T>(path: string) {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState("");
	const reload = useCallback(async () => {
		try {
			setData(await api<T>("GET", path));
			setError("");
		} catch (err) {
			setError(message(err));
		}
	}, [path]);
	useEffect(() => {
		let current = true;
		api<T>("GET", path).then(
			(result) => current && setData(result),
			(err) => current && setError(message(err)),
		);
		return () => {
			current = false;
		};
	}, [path]);
	return { data, error, reload };
}

/** Runs a change, then reloads; `notice` carries the confirmation or the error back to the screen. */
export function useAction(reload: () => Promise<void>) {
	const [notice, setNotice] = useState("");
	const [busy, setBusy] = useState(false);
	const act = useCallback(
		async (fn: () => Promise<unknown>, done = "") => {
			setBusy(true);
			try {
				await fn();
				await reload();
				setNotice(done);
				return true;
			} catch (err) {
				setNotice(message(err));
				return false;
			} finally {
				setBusy(false);
			}
		},
		[reload],
	);
	return { act, busy, notice, setNotice };
}

export type Membership = {
	memberId: string;
	role: "griever" | "supporter" | "admin";
	circleId: string;
	circleName: string;
	grieverName: string;
	circleStatus: string;
};

export type Me = {
	user: { id: string; name: string; email: string } | null;
	memberships: Membership[];
	invites: { token: string; role: string; circleName: string; grieverName: string }[];
	unread: number;
	notificationsPaused: boolean;
};

export type Connection = {
	id: string;
	kind: string;
	origin: string;
	status: string;
	updatedAt: string;
	supporterName: string | null;
};

export type Invitation = {
	id: string;
	activity: string;
	proposedFor: string;
	note: string;
	status: string;
	createdAt: string;
	fromName: string;
};

export const NEEDS: [string, string][] = [
	["alone", "Feeling alone"],
	["household", "Household responsibilities"],
	["decisions", "Making decisions"],
	["remembering", "Remembering my loved one"],
	["space", "I need some space"],
];

export const KIND_LABEL: Record<string, string> = {
	message: "A simple message",
	visit: "A short visit or coffee",
	invite: "An invitation to do something",
	quiet: "Quiet company",
	remember: "A note on a meaningful date",
};

export const STATUS_LABEL: Record<string, string> = {
	suggested: "Suggested",
	offered: "Offered",
	accepted_by_supporter: "Accepted by supporter",
	invitation_sent: "Invitation sent",
	accepted_by_griever: "Confirmed",
	declined: "Declined",
	completed: "Completed",
	canceled: "Canceled",
	sent: "Waiting for an answer",
	accepted: "Confirmed",
};

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export const formatDay = (iso: string) =>
	new Date(iso).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });

export const formatWhen = (iso: string) =>
	new Date(iso).toLocaleString(undefined, { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

export const inviteLink = (token: string) => `${window.location.origin}/ripple/join/${token}`;
