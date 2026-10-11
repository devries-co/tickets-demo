// The remembrance assistant: sorts memories into themes and offers optional
// ways to carry one forward. It organises what the person wrote; it never
// speaks for the person who died, and never invents anything about them.
//
// With an ANTHROPIC_API_KEY secret these use Claude. Without one (or if a
// reply fails validation) they fall back to simple keyword matching, and the
// result is marked "basic" so the screens can say so.

import Anthropic from "@anthropic-ai/sdk";
import { CATEGORIES, CHAPTERS, type Suggestion } from "../shared";

export type AiEnv = { ANTHROPIC_API_KEY?: string };
type Source = "ai" | "basic";

const MODEL = "claude-opus-5-5";

const RULES = `Rules that always apply:
- Work only from the words you are given. Never invent a memory, event, quote, date or fact.
- Never write as the person who died, never say or imply what they would think, feel, say or want, and never suggest they can see or hear anything now.
- You are not a therapist. Never assess the writer's wellbeing, name stages of grief, or suggest grief should lessen, resolve or end.
- Nothing is an obligation. No "should", no goals, no urgency, no pressure.
- Plain, warm language. No clichés about grief, no platitudes, no exclamation marks, no emoji.`;

/** Phrases that would mean a reply broke the rules above; such a reply is discarded. */
const FORBIDDEN =
	/would (have )?(be|been|say|said|want|wanted|love|loved|think|thought)\b|is (so )?proud|is watching|looking down|smiling down|stages? of grief|closure|move on|moving on|heal(ing)? (journey|process)|you (should|must|need to)\b/i;

async function ask<T>(env: AiEnv, system: string, input: unknown, schema: Record<string, unknown>): Promise<T | null> {
	if (!env.ANTHROPIC_API_KEY) return null;
	try {
		const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1, timeout: 30_000 });
		const response = await client.beta.messages.create({
			model: MODEL,
			max_tokens: 6000,
			system,
			// If a safety classifier declines the request, let the API retry on its recommended model.
			betas: ["server-side-fallback-2026-07-01"],
			fallbacks: "default",
			output_config: { effort: "low", format: { type: "json_schema", schema } },
			messages: [{ role: "user", content: JSON.stringify(input) }],
		});
		if (response.stop_reason !== "end_turn") return null;
		const text = response.content.find((block) => block.type === "text")?.text;
		return text ? (JSON.parse(text) as T) : null;
	} catch {
		// Not logging the error: it can echo the private memory that was sent.
		console.warn("unfinished-conversations: AI request failed, using basic matching");
		return null;
	}
}

// ------------------------------------------------------------- one memory

export type Analysis = { categories: string[]; suggestions: Suggestion[]; source: Source };
type Memory = { text: string; name: string; relationship: string };

const KEYWORDS: [string, RegExp][] = [
	["Things They Taught Me", /taught|teach|learned from|showed me how|lesson|advice|always said/i],
	["Moments I Wish They Had Seen", /wish you (could|were|had)|you would have|you'd have|made the team|graduat|wedding|born|first day|got the job|you missed/i],
	["Family Traditions", /every (year|christmas|sunday|summer|thanksgiving|birthday|morning)|tradition|always made|recipe|used to (make|take|go)/i],
	["Funny Memories", /laugh|funny|hilarious|joke|silly|cracked (me|us) up/i],
	["Things I Miss", /\bmiss(ing)?\b|wish i could (hear|see|call|hug)/i],
	["Important Milestones", /graduat|wedding|married|born|birthday|anniversary|retire|first (day|time|job|house)|made the team|promot/i],
	["Gratitude", /thank|grateful|gratitude|lucky to have/i],
	["Unsaid Words", /never (told|said)|should have (told|said)|i'm sorry|im sorry|forgive|wish i('d| had) (told|said)/i],
];

const ACTIVITY_HINTS: [RegExp, (name: string) => Suggestion[]][] = [
	[/recipe|cook|bak(e|ing)|made .*(rolls|bread|pie|soup|dinner|cookies)|kitchen/i, (n) => [
		{ text: `Write down ${n}'s recipe so it isn't lost.`, kind: "someday" },
		{ text: `Make it together on a day that mattered to ${n}.`, kind: "tradition" },
	]],
	[/fish|camp|hik|garden|trip|lake|beach|road trip/i, (n) => [
		{ text: `Plan a day doing this in ${n}'s memory.`, kind: "someday" },
		{ text: "Gather the photographs from those times in one place.", kind: "someday" },
	]],
	[/team|game|baseball|football|soccer|basketball|music|song|sang|piano|guitar/i, (n) => [
		{ text: `Start a small tradition around this in ${n}'s memory.`, kind: "tradition" },
	]],
	[/kind|welcome|generous|helped|listened|hospital/i, (n) => [
		{ text: `Write down what ${n} taught you about this.`, kind: "someday" },
		{ text: `Do one small thing for someone, the way ${n} did.`, kind: "someday" },
	]],
];

function basicAnalysis({ text, name }: Memory): Analysis {
	const categories = KEYWORDS.filter(([, pattern]) => pattern.test(text)).map(([category]) => category).slice(0, 3);
	const suggestions: Suggestion[] = [];
	for (const [pattern, make] of ACTIVITY_HINTS) if (pattern.test(text)) suggestions.push(...make(name));
	suggestions.push(
		{ text: "Save this story for someone to hear someday.", kind: "someday" },
		{ text: `Share this memory with someone who knew ${name}.`, kind: "someday" },
	);
	return { categories, suggestions: suggestions.slice(0, 4), source: "basic" };
}

const ANALYSIS_SCHEMA = {
	type: "object",
	properties: {
		categories: { type: "array", items: { type: "string", enum: CATEGORIES } },
		suggestions: {
			type: "array",
			items: {
				type: "object",
				properties: { text: { type: "string" }, kind: { type: "string", enum: ["someday", "tradition"] } },
				required: ["text", "kind"],
				additionalProperties: false,
			},
		},
	},
	required: ["categories", "suggestions"],
	additionalProperties: false,
};

const ANALYSIS_SYSTEM = `You are the memory organisation assistant in Unfinished Conversations, a private place where someone records messages and memories addressed to a person they love who has died. You are given one entry the writer has just saved, the name they use for that person, and their relationship.

Return two things.

"categories": zero to three themes from the allowed list that genuinely fit this entry. Choose none if none fit. The writer will accept or reject each one.

"suggestions": two to four optional, concrete ways the writer might carry this particular memory forward in their own life, each one short sentence drawn from details that are actually in the entry. Good suggestions preserve something (a recipe, a story, photographs), repeat something (a tradition, an outing), or pass something on (telling a child, sharing with someone who knew them). Mark a suggestion "tradition" if it is something to return to each year, otherwise "someday". Address the writer as "you" and refer to the person by the name given.

${RULES}`;

export async function analyzeMemory(env: AiEnv, memory: Memory): Promise<Analysis> {
	const fallback = basicAnalysis(memory);
	const out = await ask<{ categories: string[]; suggestions: Suggestion[] }>(
		env,
		ANALYSIS_SYSTEM,
		{ entry: memory.text.slice(0, 12000), their_name: memory.name, relationship: memory.relationship || "not given", allowed_categories: CATEGORIES },
		ANALYSIS_SCHEMA,
	);
	if (!out) return fallback;
	const suggestions = (out.suggestions ?? [])
		.map((s) => ({ text: String(s.text ?? "").trim(), kind: s.kind === "tradition" ? ("tradition" as const) : ("someday" as const) }))
		.filter((s) => s.text.length > 8 && s.text.length <= 160 && !FORBIDDEN.test(s.text))
		.slice(0, 4);
	if (suggestions.length < 2) return fallback;
	return { categories: [...new Set(out.categories ?? [])].filter((c) => CATEGORIES.includes(c)).slice(0, 3), suggestions, source: "ai" };
}

// ---------------------------------------------------------------- chapters

type ChapterItem = { id: string; title: string; excerpt: string; categories: string[] };

const CATEGORY_CHAPTER: Record<string, string> = {
	"Things They Taught Me": "The Things You Taught Us",
	"Family Traditions": "Family Traditions",
	"Moments I Wish They Had Seen": "Moments I Wish You Had Seen",
	"Important Milestones": "Moments I Wish You Had Seen",
	"Funny Memories": "Stories That Still Make Us Laugh",
	Gratitude: "Your Legacy Lives On",
	"Stories Worth Preserving": "Our Favorite Memories",
};

/** Proposes a chapter for each selected memory. Nothing is applied until the person accepts it. */
export async function suggestChapters(env: AiEnv, items: ChapterItem[]): Promise<{ chapters: Record<string, string>; source: Source }> {
	const basic: Record<string, string> = {};
	for (const item of items) {
		const matched = item.categories.map((c) => CATEGORY_CHAPTER[c]).find(Boolean);
		const keyword = KEYWORDS.find(([, pattern]) => pattern.test(`${item.title} ${item.excerpt}`))?.[0];
		basic[item.id] = matched ?? (keyword && CATEGORY_CHAPTER[keyword]) ?? "Our Favorite Memories";
	}
	const out = await ask<{ assignments: { id: string; chapter: string }[] }>(
		env,
		`You are helping someone arrange their own memories of a person who has died into the chapters of a keepsake book. For each memory, choose the chapter title it fits best from the allowed list. Use the memory's own words to decide; do not add, summarise or change anything.\n\n${RULES}`,
		{ allowed_chapters: CHAPTERS, memories: items.map((i) => ({ ...i, excerpt: i.excerpt.slice(0, 600) })) },
		{
			type: "object",
			properties: {
				assignments: {
					type: "array",
					items: {
						type: "object",
						properties: { id: { type: "string" }, chapter: { type: "string", enum: CHAPTERS } },
						required: ["id", "chapter"],
						additionalProperties: false,
					},
				},
			},
			required: ["assignments"],
			additionalProperties: false,
		},
	);
	if (!out?.assignments?.length) return { chapters: basic, source: "basic" };
	const chapters = { ...basic };
	for (const a of out.assignments) if (a.id in chapters && CHAPTERS.includes(a.chapter)) chapters[a.id] = a.chapter;
	return { chapters, source: "ai" };
}

// ---------------------------------------------------------------- summaries

/** A short summary of memories the person selected. Needs Claude; there is no keyword substitute for this. */
export async function summarize(env: AiEnv, name: string, texts: string[]): Promise<string | null> {
	const out = await ask<{ summary: string }>(
		env,
		`You are given several entries one person wrote about, or to, someone they love who has died (called "${name}" here). Write a summary of two to four sentences, in the third person about the writer's memories ("These memories describe..."), using only what the entries say. Do not add details, do not quote anyone unless the entry quotes them, and do not draw conclusions about the writer.\n\n${RULES}`,
		{ entries: texts.map((t) => t.slice(0, 4000)).slice(0, 30) },
		{ type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
	);
	const summary = out?.summary?.trim();
	return summary && summary.length <= 900 && !FORBIDDEN.test(summary) ? summary : null;
}
