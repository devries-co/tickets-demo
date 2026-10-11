// The coaching library and the cliff-aware calendar.
//
// Every text here is placeholder copy written in the spirit of Lisa's model
// and Glimmer's voice: short, warm, specific, and always ending with
// permission (no reply needed, no pressure). Swap in the real library here;
// nothing else depends on the wording.

import type { Card, Light, PlannedMessage } from "../shared";

export interface PlanCircle {
	grieverName: string;
	lovedOneName: string;
	lossDate: string; // YYYY-MM-DD, may be ""
	light: Light | null;
	card: Card;
	circleUrl: string;
	adminUrl: string;
	supportDirectoryUrl: string;
}

const DAY = 86_400_000;

export function daysBetween(fromIso: string, toIso: string): number {
	return Math.round((Date.parse(toIso + "T00:00:00Z") - Date.parse(fromIso + "T00:00:00Z")) / DAY);
}

export function addDays(iso: string, n: number): string {
	return new Date(Date.parse(iso + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
}

function sameDay(dateIso: string, yearly: boolean, targetIso: string): boolean {
	return yearly ? dateIso.slice(5) === targetIso.slice(5) : dateIso === targetIso;
}

/** "Mark", or a gentler stand-in when the griever has asked people not to say the name yet. */
function nameOrLoss(c: PlanCircle): string {
	return c.card.sayName === "not_yet" ? `${c.grieverName}'s loss` : c.lovedOneName;
}

function exampleText(c: PlanCircle, occasion: string): string {
	if (c.card.sayName === "not_yet") return `"Thinking of you ${occasion}. No need to reply."`;
	return `"Thinking about ${c.lovedOneName} ${occasion}, and about you. No need to reply."`;
}

/** How to show up, given today's light. The light always wins over the calendar. */
function lightTip(c: PlanCircle, occasion: string): string {
	const g = c.grieverName;
	const ex = exampleText(c, occasion);
	switch (c.light) {
		case "on":
			return `${g}'s light is on, so a call or a visit would be welcome. If you text instead, try: ${ex}`;
		case "off":
			return `${g}'s light is off, so please hold off on calls and visits. One short text with no need to reply is plenty, or simply hold ${g} in mind. If you text: ${ex}`;
		default:
			return `${g}'s light is dim. A two-line text will mean more than you think. Here's an example: ${ex}`;
	}
}

function nameTip(c: PlanCircle): string {
	return c.card.sayName === "yes" ? ` Say ${c.lovedOneName}'s name. It's a gift, not a wound.` : "";
}

/** Everything Porchlight would send for one circle on one local calendar day. */
export function planForDate(c: PlanCircle, today: string): PlannedMessage[] {
	const out: PlannedMessage[] = [];
	const g = c.grieverName;
	const tomorrow = addDays(today, 1);
	const link = `\n${c.circleUrl}`;

	for (const hd of c.card.hardDates) {
		if (sameDay(hd.date, hd.yearly, tomorrow)) {
			out.push({
				audience: "circle",
				kind: `hard-date-eve:${hd.id}`,
				body: `Tomorrow is ${hd.label}. ${lightTip(c, "today")}${nameTip(c)}${link}`,
			});
		}
		if (sameDay(hd.date, hd.yearly, today)) {
			out.push({
				audience: "griever",
				kind: `hard-date-day:${hd.id}`,
				body: `Today is ${hd.label}. You don't owe anyone anything today. Your circle will take their cue from your light, and you can change it anytime:\n${c.adminUrl}`,
			});
		}
	}

	if (!c.lossDate) return out;
	const days = daysBetween(c.lossDate, today);
	const who = nameOrLoss(c);
	const since = c.card.sayName === "not_yet" ? who : `${who} died`;

	if (days === 42) {
		out.push({
			audience: "circle",
			kind: "week-6",
			body: `It's been six weeks since ${since}. This is when most people stop checking in. Don't. ${lightTip(c, "this week")}${link}`,
		});
	}
	if (days === 90) {
		out.push({
			audience: "circle",
			kind: "month-3",
			body: `Three months. The meals have stopped and the world has moved on, but ${g} hasn't had that luxury. A note this week still matters. ${lightTip(c, "these days")}${link}`,
		});
		out.push({
			audience: "griever",
			kind: "month-3-groups",
			body: `Three months. However this feels, it makes sense. If you'd ever like to sit with people who get it, there are support groups near you:\n${c.supportDirectoryUrl}\nNo pressure. This is just here for whenever you want it.`,
		});
	}
	if (days === 358) {
		out.push({
			audience: "circle",
			kind: "year-1-week-before",
			body: `One week from today marks a year since ${since}. Anniversaries often land harder than people expect, and the days before can be heavy too. Put it in your calendar now.${nameTip(c)}${link}`,
		});
		out.push({
			audience: "griever",
			kind: "year-1-week-before",
			body: `The one-year mark is a week away. You don't have to plan anything. If it helps, you can set your light ahead of time and your circle will follow your lead:\n${c.adminUrl}`,
		});
	}
	if (days === 364) {
		out.push({
			audience: "circle",
			kind: "year-1-eve",
			body: `Tomorrow marks one year since ${since}. ${lightTip(c, "today")}${nameTip(c)}${link}`,
		});
	}
	if (days === 365) {
		out.push({
			audience: "griever",
			kind: "year-1-day",
			body: `A year. You carried it. Whatever today looks like is okay, and your light is yours to set:\n${c.adminUrl}`,
		});
	}
	// At most one text to the circle per day; hard dates come first and already carry the light's advice.
	const firstCircle = out.findIndex((m) => m.audience === "circle");
	return out.filter((m, i) => m.audience !== "circle" || i === firstCircle);
}

export function lightChangeText(c: PlanCircle, light: Light, note: string): string {
	const g = c.grieverName;
	const extra = note ? `\n${g} says: "${note}"` : "";
	const body = {
		on: `🟢 ${g}'s porch light is on. ${g} would welcome company or a call today.`,
		dim: `🟡 ${g}'s light is dim. Thinking of ${g} is enough today. A text, not a call, and no reply expected.`,
		off: `⚫ ${g} has turned the light off for today. ${g} is okay and needs some space, so there's no need to check in. The light will come back on.`,
	}[light];
	return `${body}${extra}\n${c.circleUrl}`;
}

export function welcomeText(c: PlanCircle, supporterName: string): string {
	const g = c.grieverName;
	return `Hi ${supporterName}, you've joined ${g}'s Porchlight circle. You'll get a text when ${g}'s light changes, plus a few gentle tips around hard days. ${g} doesn't owe anyone updates; the light is just a hint about what helps. See it anytime:\n${c.circleUrl}\nReply STOP to leave.`;
}

export function stepAwayText(grieverName: string): string {
	return `${grieverName} is stepping away for 15 minutes. No need to follow up or ask about it. (Sent via Porchlight)`;
}
