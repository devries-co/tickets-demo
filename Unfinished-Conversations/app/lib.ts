import { useCallback, useEffect, useState } from "react";
import { CHUNK_BYTES, type LovedOne, type Prefs } from "../shared";

export const BASE = "/unfinished-conversations";
const API = "/api/unfinished-conversations";

export async function api<T = { ok: true }>(method: string, path: string, body?: unknown): Promise<T> {
	const res = await fetch(`${API}${path}`, {
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

export const mediaUrl = (assetId: string, download = false) => `${API}/media/${assetId}${download ? "?download=1" : ""}`;
export const listenAudioUrl = (token: string) => `${API}/listen/${token}/audio`;
export const listenPageUrl = (token: string) => `${window.location.origin}${BASE}/listen/${token}`;
export const inviteUrl = (token: string) => `${window.location.origin}${BASE}/join/${token}`;

/**
 * Uploads a recording or photograph in pieces. Each piece is retried on its
 * own, so a dropped connection part-way through a long recording costs one
 * piece, not the whole thing.
 */
export async function upload(blob: Blob, kind: "audio" | "image", extra: { durationMs?: number; name?: string } = {}, onProgress?: (fraction: number) => void) {
	const { id } = await api<{ id: string }>("POST", "/assets", { kind, mime: blob.type, size: blob.size, ...extra });
	const pieces = Math.ceil(blob.size / CHUNK_BYTES);
	for (let i = 0; i < pieces; i++) {
		const piece = blob.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
		for (let attempt = 0; ; attempt++) {
			const res = await fetch(`${API}/assets/${id}/chunks/${i}`, { method: "PUT", body: piece, credentials: "same-origin" }).catch(() => null);
			if (res?.ok) break;
			if (attempt >= 3) throw new Error("The upload was interrupted. Please check your connection and try again.");
			await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
		}
		onProgress?.((i + 1) / pieces);
	}
	await api("POST", `/assets/${id}/complete`);
	return id;
}

/** Scales a photograph down to at most 1800px and re-encodes it, which also strips location and camera data. */
export async function optimizeImage(file: File): Promise<Blob> {
	const bitmap = await createImageBitmap(file).catch(() => null);
	if (!bitmap) throw new Error("That photograph couldn't be opened. Please try a JPG or PNG.");
	const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	for (const quality of [0.86, 0.72, 0.55]) {
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
		if (blob && blob.size < 1_900_000) return blob;
	}
	throw new Error("That photograph is too large to save.");
}

/** Loads a resource once and exposes `reload` for after a change. */
export function useLoad<T>(path: string | null) {
	const [data, setData] = useState<T | null>(null);
	const [error, setError] = useState("");
	const reload = useCallback(async () => {
		if (!path) return;
		try {
			setData(await api<T>("GET", path));
			setError("");
		} catch (err) {
			setError(message(err));
		}
	}, [path]);
	useEffect(() => {
		if (!path) return;
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
export function useAction(reload: () => Promise<void> | void) {
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

export type Me = {
	user: { id: string; name: string; email: string } | null;
	prefs: Prefs;
	lovedOnes: LovedOne[];
	invites: { token: string; role: string; collectionName: string; inviterName: string }[];
	/** True when suggestions come from Claude; false when the server is using basic keyword matching. */
	aiService: boolean;
};

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
export const dayTime = (iso: string) => new Date(iso).toLocaleString(undefined, { year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
export const monthOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long" });

/** Days until the next occurrence of a month and day, by the person's own calendar. */
export function daysUntil(month: number, dayOfMonth: number) {
	const today = new Date();
	const start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
	let next = new Date(today.getFullYear(), month - 1, dayOfMonth).getTime();
	if (next < start) next = new Date(today.getFullYear() + 1, month - 1, dayOfMonth).getTime();
	return Math.round((next - start) / 86_400_000);
}

export function clock(ms: number) {
	const total = Math.max(0, Math.round(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export const TYPE_LABEL = { voice: "Recorded message", letter: "Letter", memory: "Memory" };

export const store = {
	get(key: string) {
		try {
			return localStorage.getItem(key);
		} catch {
			return null;
		}
	},
	set(key: string, value: string) {
		try {
			localStorage.setItem(key, value);
		} catch {
			// storage unavailable: the preference just won't be remembered
		}
	},
};
