// Validation rules shared by the form and the server.

export const MAX_NAME = 120;
export const MAX_WORDS = 20;
export const MAX_TEXT_CHARS = 400;
/** Photos are cropped and resized in the browser before upload, so this is generous. */
export const MAX_PHOTO_BYTES = 400_000;

// Intl.Segmenter exists in every current browser and in Workers, but not in the older TypeScript lib the app targets.
type SegmenterConstructor = new (
	locale: undefined,
	options: { granularity: "word" },
) => { segment(text: string): Iterable<{ isWordLike?: boolean }> };

/**
 * Counts words in any language. Uses the platform's word segmenter where
 * there is one, so text without spaces (Chinese, Japanese, Thai) is counted
 * by word and not as a single run.
 */
export function countWords(text: string) {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	const Segmenter = (Intl as unknown as { Segmenter?: SegmenterConstructor }).Segmenter;
	if (Segmenter) {
		let count = 0;
		for (const part of new Segmenter(undefined, { granularity: "word" }).segment(trimmed)) {
			if (part.isWordLike) count++;
		}
		// Punctuation-only text has no word-like segments; fall through to whitespace counting.
		if (count) return count;
	}
	return trimmed.split(/\s+/u).length;
}

/** Lower-case, accent-free form of a name, so "José" is found by typing "jose". */
export function normalizeName(name: string) {
	return name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

export const cleanLine = (value: string) => value.replace(/\s+/gu, " ").trim();

export type Memorial = {
	id: string;
	name: string;
	text: string;
	hasPhoto: boolean;
	slot: number;
	color: string;
	publishedAt: string;
};

export type Stats = {
	/** Published memorials: the number shown as "Lives Remembered". */
	published: number;
	/** Slots handed out so far, including any later removed. Sets the size names are drawn at. */
	slots: number;
	/** Slots that were handed out but are not currently published. */
	vacant: number[];
};
