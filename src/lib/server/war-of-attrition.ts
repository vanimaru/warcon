// The War of Attrition rule (kind `war_of_attrition`): each side has a number of lives for the
// match, and the first side to lose them all loses it. The game's own scoring still runs; the rule
// counts each side's deaths from the kill feed, and as one side reaches the rule's limit the side
// in play with the fewest deaths wins: the rule announces it and ends the match (POST
// /v1/match/end, Match control). Meant for two sides: the rule can leave a faction out of the count
// (closed with a Team balance rule), and with three in play the side with the fewest deaths of the
// others wins (a tie between them is a draw). A time limit can end it sooner, the side with the
// fewest deaths winning; a match the game ends first is told by its deaths as they stood.
//
// A death is a player killed by the other side; one by their own hand or the world (a suicide, a
// fall, a kill the panel's own rules make to move someone) counts only when the rule says so, and a
// team kill never. The counts are read from the kills the feed stored for the match in progress
// (kills.match_row), so they are the same after a worker restart; what the rule keeps in memory is
// what it has said this match, and its outbox rows carry the match in their dedupe keys. Pure here;
// feed-events.ts (each kill batch) and triggers.ts (each look) act on it.
import { ApiError, int, str } from './http';
import { settingsFingerprint } from './fingerprint';
import { WAR_OF_ATTRITION_DEFAULTS } from '$lib/war-of-attrition-defaults';

export { WAR_OF_ATTRITION_DEFAULTS };

export const ATTRITION_DEFAULT_LIMIT = 100;
export const ATTRITION_MIN_LIMIT = 5;
export const ATTRITION_MAX_LIMIT = 5000;
export const ATTRITION_MAX_LIMIT_MINUTES = 180;
export const ATTRITION_DEFAULT_TIME_WARNINGS = [5, 1];
export const ATTRITION_DEFAULT_MILESTONES = [50, 75, 90];
const MAX_WARNINGS = 10;
const MAX_MILESTONES = 10;

export interface AttritionConfig {
	/** the deaths that lose a side the match */
	limit: number;
	/** a faction left out of the count and the win (closed by a Team balance rule); '' for none */
	leftOut: string;
	/** deaths by a player's own hand or the world count too */
	countSelfInflicted: boolean;
	/** percentages of the limit announced as the side with the most deaths first reaches each */
	milestones: number[];
	/** the match's time limit in minutes (0: none): the side with the fewest deaths then wins */
	timeLimitMinutes: number;
	/** minutes left announced as the limit nears */
	timeWarnings: number[];
	startMessage: string;
	milestoneMessage: string;
	winMessage: string;
	timeWinMessage: string;
	drawMessage: string;
	timeLeftMessage: string;
}

/** A list of whole numbers from 1 to `max`, each once. */
function numbers(raw: unknown, fallback: number[], max: number, most: number, what: string) {
	const out: number[] = [];
	const list = Array.isArray(raw) ? raw : raw === undefined ? fallback : [];
	for (const v of list) {
		const n = int(v, 0, 0, max);
		if (n >= 1 && !out.includes(n)) out.push(n);
	}
	if (out.length > most) throw new ApiError(400, `At most ${most} ${what}.`);
	return out;
}

export function validateAttrition(c: Record<string, unknown>): AttritionConfig {
	const limit = int(c.limit, ATTRITION_DEFAULT_LIMIT);
	if (limit < ATTRITION_MIN_LIMIT || limit > ATTRITION_MAX_LIMIT)
		throw new ApiError(
			400,
			`The deaths that lose a side go from ${ATTRITION_MIN_LIMIT} to ${ATTRITION_MAX_LIMIT}.`
		);
	const text = (k: keyof typeof WAR_OF_ATTRITION_DEFAULTS) =>
		c[k] === undefined ? WAR_OF_ATTRITION_DEFAULTS[k] : str(c[k], 256);
	return {
		limit,
		leftOut: c.leftOut === undefined ? '' : str(c.leftOut, 64),
		countSelfInflicted: c.countSelfInflicted === true,
		milestones: numbers(
			c.milestones,
			ATTRITION_DEFAULT_MILESTONES,
			99,
			MAX_MILESTONES,
			'percentages of the limit to announce'
		).sort((a, b) => a - b),
		timeLimitMinutes: int(c.timeLimitMinutes, 0, 0, ATTRITION_MAX_LIMIT_MINUTES),
		timeWarnings: numbers(
			c.timeWarnings,
			ATTRITION_DEFAULT_TIME_WARNINGS,
			ATTRITION_MAX_LIMIT_MINUTES,
			MAX_WARNINGS,
			'times left to announce'
		).sort((a, b) => b - a),
		startMessage: text('startMessage'),
		milestoneMessage: text('milestoneMessage'),
		winMessage: text('winMessage'),
		timeWinMessage: text('timeWinMessage'),
		drawMessage: text('drawMessage'),
		timeLeftMessage: text('timeLeftMessage')
	};
}

/** The fingerprint a rule's rows carry: an announcement decided under other settings is not sent. */
export const attritionSettingsKey = (cfg: AttritionConfig): string => settingsFingerprint(cfg);

/** Whether the rule says anything to players (and so needs Chat). */
export const attritionSpeaks = (cfg: Partial<AttritionConfig> | null | undefined): boolean =>
	!!cfg &&
	(Object.keys(WAR_OF_ATTRITION_DEFAULTS) as (keyof typeof WAR_OF_ATTRITION_DEFAULTS)[]).some(
		(k) => (cfg[k] === undefined ? WAR_OF_ATTRITION_DEFAULTS[k] : str(cfg[k])) !== ''
	);

// ---- the count ---------------------------------------------------------------------------------

/** One side's deaths in the match, as the database adds them up. */
export interface DeathLine {
	faction: string;
	/** killed by another side */
	deaths: number;
	/** by their own hand or the world (suicides, falls, the panel's own kills) */
	selfInflicted: number;
}

export interface AttritionTally {
	/** each side in play, fewest deaths first; the scoreboard's sides start at 0 */
	sides: { faction: string; deaths: number }[];
}

/**
 * The deaths of the sides in play under the rule's settings: the scoreboard's factions (and any
 * the feed names) but the one left out.
 */
export function attritionTally(
	cfg: Pick<AttritionConfig, 'leftOut' | 'countSelfInflicted'>,
	lines: DeathLine[],
	factions: string[] = []
): AttritionTally {
	const out = cfg.leftOut.toLowerCase();
	const by = new Map<string, number>();
	for (const f of factions) if (f && f.toLowerCase() !== out) by.set(f, 0);
	for (const l of lines) {
		if (!l.faction || l.faction.toLowerCase() === out) continue;
		const n = l.deaths + (cfg.countSelfInflicted ? l.selfInflicted : 0);
		by.set(l.faction, (by.get(l.faction) ?? 0) + n);
	}
	const sides = [...by.entries()]
		.map(([faction, deaths]) => ({ faction, deaths: Math.max(0, deaths) }))
		.sort((a, b) => a.deaths - b.deaths || a.faction.localeCompare(b.faction));
	return { sides };
}

/** "Valkyra 38/100 · Lonestar 42/100", fewest deaths first. */
export const attritionStandings = (t: AttritionTally, limit: number): string =>
	t.sides.map((s) => `${s.faction} ${s.deaths}/${limit}`).join(' · ');

/** The side with the fewest deaths of these, or null for a tie at the bottom (or none). */
function fewest(sides: AttritionTally['sides']): { faction: string; deaths: number } | null {
	const [first, second] = [...sides].sort((a, b) => a.deaths - b.deaths);
	if (!first) return null;
	if (second && second.deaths === first.deaths) return null;
	return first;
}

// ---- what is said and done ----------------------------------------------------------------------

/** What the rule has said in one match. */
export interface AttritionMemory {
	/** the settings and the match it was kept for: either changing starts it over */
	key: string;
	match: string;
	/** the percentages of the limit announced */
	told: Set<number>;
	/** decided (won, drawn or timed out): nothing more is said this match */
	decided: boolean;
	/** when the match's clock started (ms), and whether that is a guess until the feed says */
	clockFrom: number;
	clockGuessed: boolean;
	timeWarned: Set<number>;
	/** the last count read, for a look that has to decide without a batch */
	last: AttritionTally | null;
}

export const newAttritionMemory = (
	key: string,
	match: string,
	now: number,
	guessed: boolean
): AttritionMemory => ({
	key,
	match,
	told: new Set(),
	decided: false,
	clockFrom: now,
	clockGuessed: guessed,
	timeWarned: new Set(),
	last: null
});

export type AttritionNews =
	| { kind: 'milestone'; faction: string; deaths: number; percent: number; tally: AttritionTally }
	| {
			kind: 'win';
			winner: string;
			loser: string | null;
			tally: AttritionTally;
			why: 'limit' | 'time' | 'match';
	  }
	| { kind: 'draw'; loser: string | null; tally: AttritionTally; why: 'limit' | 'time' | 'match' }
	| { kind: 'time'; minutes: number; tally: AttritionTally };

/**
 * A new count: each percentage of the limit as the side with the most deaths first reaches it
 * (once, the highest of several), and the end as a side reaches the limit: the side in play with
 * the fewest deaths of the others wins, or a draw when they tie. A memory that has just been made
 * (a restart mid-match, a rule switched on) takes the percentages passed as said. Mutates `mem`.
 */
export function attritionStep(
	cfg: AttritionConfig,
	mem: AttritionMemory,
	t: AttritionTally,
	fresh = false
): AttritionNews[] {
	mem.last = t;
	if (mem.decided || !t.sides.length) return [];
	const worst = t.sides.at(-1)!;
	if (worst.deaths >= cfg.limit) {
		mem.decided = true;
		const rest = t.sides.filter((s) => s.faction !== worst.faction);
		const w = fewest(rest);
		return [
			w
				? { kind: 'win', winner: w.faction, loser: worst.faction, tally: t, why: 'limit' }
				: { kind: 'draw', loser: worst.faction, tally: t, why: 'limit' }
		];
	}
	const reached = cfg.milestones.filter(
		(m) => worst.deaths >= (cfg.limit * m) / 100 && !mem.told.has(m)
	);
	for (const m of reached) mem.told.add(m);
	if (fresh || !reached.length) return [];
	return [
		{
			kind: 'milestone',
			faction: worst.faction,
			deaths: worst.deaths,
			percent: Math.max(...reached),
			tally: t
		}
	];
}

/**
 * The clock at a look: the time left announced at each warning (once, the lowest reached), and at
 * the limit the side with the fewest deaths wins (a tie is a draw). Mutates `mem`.
 */
export function attritionClock(
	cfg: AttritionConfig,
	mem: AttritionMemory,
	now: number
): AttritionNews[] {
	if (!cfg.timeLimitMinutes || mem.decided || !mem.clockFrom) return [];
	const t = mem.last ?? { sides: [] };
	const left = mem.clockFrom + cfg.timeLimitMinutes * 60_000 - now;
	if (left <= 0) {
		mem.decided = true;
		const w = fewest(t.sides);
		return [
			w
				? { kind: 'win', winner: w.faction, loser: null, tally: t, why: 'time' }
				: { kind: 'draw', loser: null, tally: t, why: 'time' }
		];
	}
	const reached = cfg.timeWarnings.filter(
		(w) => w < cfg.timeLimitMinutes && left <= w * 60_000 && !mem.timeWarned.has(w)
	);
	if (!reached.length) return [];
	for (const w of reached) mem.timeWarned.add(w);
	return [{ kind: 'time', minutes: Math.ceil(left / 60_000), tally: t }];
}

/** The game ended the match before the war was decided: told by the deaths as they stood. */
export function attritionAtMatchEnd(mem: AttritionMemory): AttritionNews[] {
	if (mem.decided || !mem.last) return [];
	mem.decided = true;
	if (!mem.last.sides.some((s) => s.deaths > 0)) return [];
	const w = fewest(mem.last.sides);
	return [
		w
			? { kind: 'win', winner: w.faction, loser: null, tally: mem.last, why: 'match' }
			: { kind: 'draw', loser: null, tally: mem.last, why: 'match' }
	];
}

/** A memory made mid-match is timed from then; the feed's match clock says when the match began. */
export function syncAttritionClock(mem: AttritionMemory, receivedAt: number, eventTimeS: number) {
	if (!mem.clockGuessed || !Number.isFinite(eventTimeS) || eventTimeS < 0) return;
	mem.clockFrom = receivedAt - eventTimeS * 1000;
	mem.clockGuessed = false;
}

// ---- worker memory ------------------------------------------------------------------------------

const memories = new Map<string, { serverId: string; mem: AttritionMemory }>();

/** The rule's memory for this match, made (and flagged fresh) when there is none for it. */
export function attritionMemory(
	serverId: string,
	ruleId: string,
	key: string,
	match: string,
	now: number,
	guessed: boolean
): { mem: AttritionMemory; fresh: boolean } {
	const kept = memories.get(ruleId);
	if (kept && kept.mem.key === key && kept.mem.match === match)
		return { mem: kept.mem, fresh: false };
	const mem = newAttritionMemory(key, match, now, guessed);
	memories.set(ruleId, { serverId, mem });
	return { mem, fresh: true };
}

/** The rule's memory whatever match it is for, if its settings still hold. */
export const knownAttrition = (ruleId: string, key: string): AttritionMemory | undefined => {
	const kept = memories.get(ruleId);
	return kept?.mem.key === key ? kept.mem : undefined;
};

/** Forgets one server's rules that are no longer on. */
export function keepAttritions(serverId: string, live: Set<string>): void {
	for (const [id, k] of memories) if (k.serverId === serverId && !live.has(id)) memories.delete(id);
}

export function forgetAttritions(): void {
	memories.clear();
}
