// Types and copy shared by the Porchlight worker and the React pages.

export type Light = "on" | "dim" | "off";

export const LIGHTS: Record<Light, { emoji: string; label: string; meaning: string }> = {
	on: { emoji: "🟢", label: "On", meaning: "I'd welcome company or a call" },
	dim: { emoji: "🟡", label: "Dim", meaning: "Thinking of you is enough. Text, don't call" },
	off: { emoji: "⚫", label: "Off", meaning: "I need space today. I'm okay, and I'll turn it back on" },
};

export const HELP_OPTIONS = [
	{ id: "errands", label: "Errands" },
	{ id: "kids", label: "Kids" },
	{ id: "paperwork", label: "Paperwork" },
	{ id: "pets", label: "Pets" },
	{ id: "house", label: "House & yard" },
	{ id: "rides", label: "Rides" },
	{ id: "nothing", label: "Nothing right now" },
] as const;

export interface HardDate {
	id: string;
	label: string;
	/** YYYY-MM-DD; when `yearly`, only the month and day matter */
	date: string;
	yearly: boolean;
}

export interface Card {
	sayName: "yes" | "not_yet" | null;
	meals: "yes" | "no" | null;
	allergies: string;
	help: string[];
	hardDates: HardDate[];
	note: string;
}

export const EMPTY_CARD: Card = {
	sayName: null,
	meals: null,
	allergies: "",
	help: [],
	hardDates: [],
	note: "",
};

export const WORK_MENTION = {
	acknowledge: "A quiet \"I'm sorry\" is welcome",
	dont_mention: "Please don't bring it up. I'll mention it if I want to",
	normal: "Treat me normally. Work is a welcome distraction",
} as const;
export type WorkMention = keyof typeof WORK_MENTION;

export const WORK_HELPS = [
	{ id: "deadlines", label: "Some flexibility on deadlines" },
	{ id: "heads_up", label: "A heads-up before topics that might be hard" },
	{ id: "lunch", label: "Lunch or coffee invites (no pressure)" },
	{ id: "quiet", label: "Space. I may be quieter than usual" },
	{ id: "camera", label: "Camera-off on video calls is okay" },
] as const;

export interface WorkCard {
	enabled: boolean;
	mention: WorkMention | null;
	helps: string[];
	note: string;
	managerName: string;
	managerPhone: string;
}

export const EMPTY_WORK: WorkCard = {
	enabled: false,
	mention: null,
	helps: [],
	note: "",
	managerName: "",
	managerPhone: "",
};

/** What anyone with the circle link can see. No phone numbers. */
export interface PublicCircle {
	grieverName: string;
	lovedOneName: string;
	light: Light | null;
	lightNote: string;
	card: Card;
	sponsor: string;
	circleSize: number;
	daysSinceLoss: number | null;
}

export interface Supporter {
	id: string;
	name: string;
	relationship: string;
	active: boolean;
	joinedAt: number;
}

export interface OutboxMessage {
	id: number;
	recipientName: string;
	phone: string;
	kind: string;
	body: string;
	status: "sent" | "demo" | "failed";
	error: string;
	createdAt: number;
}

export interface PlannedMessage {
	audience: "circle" | "griever";
	kind: string;
	body: string;
}

/** The griever's private view. */
export interface AdminCircle extends PublicCircle {
	joinCode: string;
	workCode: string;
	grieverPhone: string;
	relationship: string;
	lossDate: string;
	timezone: string;
	work: WorkCard;
	supporters: Supporter[];
	outbox: OutboxMessage[];
	smsLive: boolean;
	supportDirectoryUrl: string;
	pendingNotify: boolean;
}

export interface WorkView {
	grieverName: string;
	mention: WorkMention | null;
	helps: string[];
	note: string;
}
