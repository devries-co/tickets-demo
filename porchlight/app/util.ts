import { useEffect, useState } from "react";
import type { HardDate } from "../shared";

/** A brief "Saved" style confirmation. */
export function useFlash(): [string, (msg: string) => void] {
	const [msg, setMsg] = useState("");
	useEffect(() => {
		if (!msg) return;
		const t = setTimeout(() => setMsg(""), 2600);
		return () => clearTimeout(t);
	}, [msg]);
	return [msg, setMsg];
}

// ---------- dates ----------

export function todayIso(): string {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function addDays(iso: string, n: number): string {
	return new Date(Date.parse(iso + "T00:00:00Z") + n * 86_400_000).toISOString().slice(0, 10);
}

/** The next date (today or later) this hard date falls on, or null if it's a past one-time date. */
export function nextOccurrence(hd: HardDate, from = todayIso()): string | null {
	if (!hd.yearly) return hd.date >= from ? hd.date : null;
	const year = Number(from.slice(0, 4));
	const md = hd.date.slice(5);
	const thisYear = `${year}-${md}`;
	return thisYear >= from ? thisYear : `${year + 1}-${md}`;
}

export function prettyDate(iso: string, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }) {
	return new Date(iso + "T12:00:00").toLocaleDateString(undefined, opts);
}

export function timeAgo(ms: number): string {
	const mins = Math.round((Date.now() - ms) / 60000);
	if (mins < 1) return "just now";
	if (mins < 60) return `${mins} min ago`;
	const hrs = Math.round(mins / 60);
	if (hrs < 24) return `${hrs} hr ago`;
	return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** nth weekday of a month, e.g. 4th Thursday of November. weekday: 0 = Sunday. */
function nthWeekday(year: number, month: number, weekday: number, n: number): string {
	const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
	const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
	return `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Holidays that move around get a one-time date for their next occurrence. */
export function upcomingHoliday(kind: "thanksgiving" | "mothers" | "fathers"): string {
	const today = todayIso();
	const y = Number(today.slice(0, 4));
	const pick = (yr: number) =>
		kind === "thanksgiving" ? nthWeekday(yr, 10, 4, 4) : kind === "mothers" ? nthWeekday(yr, 4, 0, 2) : nthWeekday(yr, 5, 0, 3);
	return pick(y) >= today ? pick(y) : pick(y + 1);
}

export function nextFixed(md: string): string {
	const today = todayIso();
	const y = Number(today.slice(0, 4));
	return `${y}-${md}` >= today ? `${y}-${md}` : `${y + 1}-${md}`;
}

export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}
