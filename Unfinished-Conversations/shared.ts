// Constants and types shared by the screens and the server.

export const CATEGORIES = [
	"Things They Taught Me",
	"Moments I Wish They Had Seen",
	"Family Traditions",
	"Funny Memories",
	"Things I Miss",
	"Important Milestones",
	"Stories Worth Preserving",
	"Gratitude",
	"Unsaid Words",
];

export const CHAPTERS = [
	"The Things You Taught Us",
	"Our Favorite Memories",
	"Family Traditions",
	"Moments I Wish You Had Seen",
	"Stories That Still Make Us Laugh",
	"Your Legacy Lives On",
];

export const PROMPTS = [
	"What's something you wish you could tell them?",
	"Did something happen today that reminded you of them?",
	"What would make them smile?",
	"What's something you've never said out loud?",
	"What's something they taught you that you still carry?",
];

/** Upload pieces. Small enough for one database row, large enough that a ten-minute recording is a few dozen requests. */
export const CHUNK_BYTES = 512 * 1024;
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_RECORDING_MINUTES = 15;

export type Prefs = { ai: boolean; reminders: boolean };

export type LovedOne = {
	id: string;
	name: string;
	nickname: string;
	relationship: string;
	photoAssetId: string | null;
	birthDate: string | null;
	deathDate: string | null;
};

export type Photo = { assetId: string; caption: string };
export type Category = { id: string; name: string; source: "ai" | "user"; status: "suggested" | "approved" | "rejected" };

export type Entry = {
	id: string;
	lovedOneId: string;
	type: "voice" | "letter" | "memory";
	title: string;
	content: string;
	transcript: string;
	audioAssetId: string | null;
	durationMs: number | null;
	tags: string[];
	draft: boolean;
	createdAt: string;
	updatedAt: string;
	photos: Photo[];
	categories: Category[];
};

export type ActivityNote = { id: string; text: string; assetId: string | null; createdAt: string };
export type Activity = {
	id: string;
	entryId: string | null;
	description: string;
	kind: "someday" | "tradition";
	plannedDate: string | null;
	status: "open" | "done" | "archived";
	createdAt: string;
	notes: ActivityNote[];
};

export type ImportantDate = { id: string; label: string; month: number; day: number; daysAway: number };

export type Suggestion = { text: string; kind: "someday" | "tradition" };

/** What the person calls them: the nickname if they gave one, otherwise the name. */
export const calls = (lovedOne: { name: string; nickname: string }) => lovedOne.nickname || lovedOne.name;
