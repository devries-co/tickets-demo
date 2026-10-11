import type { Memorial, Stats } from "../shared/text";

export async function api<T = { ok: true }>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`/api/never-forgotten${path}`, {
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

export const getStats = () => api<Stats>("GET", "/stats");
export const getMemorial = (id: string) => api<{ memorial: Memorial }>("GET", `/memorial/${encodeURIComponent(id)}`).then((r) => r.memorial);
export const getMemorialAtSlot = (slot: number) => api<{ memorial: Memorial }>("GET", `/slot/${slot}`).then((r) => r.memorial);
export const search = (q: string) => api<{ results: Memorial[] }>("GET", `/search?q=${encodeURIComponent(q)}`).then((r) => r.results);
export const getNames = (query: string) => api<{ names: [number, string][] }>("GET", `/names?${query}`).then((r) => r.names);

export const photoUrl = (id: string) => `/api/never-forgotten/photo/${encodeURIComponent(id)}`;
export const memorialUrl = (id: string) => `${window.location.origin}/never-forgotten/remember/${id}`;

export const BASE = "/never-forgotten";

/** Tokens for this browser's own submissions, so "find their place" is offered once they are published. */
export const mine = {
	list(): string[] {
		try {
			return JSON.parse(localStorage.getItem("nf-submissions") ?? "[]");
		} catch {
			return [];
		}
	},
	add(token: string) {
		try {
			localStorage.setItem("nf-submissions", JSON.stringify([...mine.list(), token].slice(-12)));
		} catch {
			// storage unavailable: the status link shown on screen still works
		}
	},
	remove(token: string) {
		try {
			localStorage.setItem("nf-submissions", JSON.stringify(mine.list().filter((t) => t !== token)));
		} catch {
			// ignore
		}
	},
};
