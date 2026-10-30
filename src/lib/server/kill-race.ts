// The Kill race rule (kind `kill_race`): a team deathmatch on top of the game's own match. The game
// scores a side for holding the control zone and ends the match at its cap, which the panel cannot
// change; the rule counts each side's kills from the kill feed instead, and the first side to the
// rule's target wins: the rule announces it and ends the match (POST /v1/match/end, Match control).
// A time limit can end it sooner, the side with the most kills then winning; a match the game ends
// first (a side reached the score cap) is announced by its kills all the same.
//
// The counts are read from the kills the feed stored for the match in progress (kills.match_row),
// so they are the same after a worker restart. What the rule keeps in memory is only what it has
// said this match: the announcements go out once each, and their outbox rows carry the match in
// their dedupe keys, so a restart that says it again sends nothing twice. Pure here; feed-events.ts
// (each kill batch) and triggers.ts (each look) act on it.
import { ApiError, int, str } from './http';
import { settingsFingerprint } from './fingerprint';
import { causeTags } from './cause-tags';
import { causeLabel } from '$lib/causes';
import { KILL_RACE_DEFAULTS } from '$lib/kill-race-defaults';

export { KILL_RACE_DEFAULTS };

export const KILL_RACE_DEFAULT_TARGET = 100;
export const KILL_RACE_MIN_TARGET = 5;
export const KILL_RACE_MAX_TARGET = 5000;
export const KILL_RACE_MAX_LIMIT_MINUTES = 180;
export const KILL_RACE_MAX_CAUSES = 150;
export const KILL_RACE_DEFAULT_TIME_WARNINGS = [5, 1];
const MAX_WARNINGS = 10;

export interface KillRaceConfig {
	/** the kills a side needs to win */
	target: number;
	/** only headshots count */
	headshotsOnly: boolean;
	/** a team kill takes one off the killer's side */
	teamKillsSubtract: boolean;
	/** the kill feed tags of the weapons whose kills count; empty: every weapon */
	causes: string[];
	/** the standings are announced each time the leader reaches a multiple of this (0: never) */
	announceEvery: number;
	/** the match's time limit in minutes (0: none): the side with the most kills then wins */
	timeLimitMinutes: number;
	/** minutes left announced as the limit nears */
	timeWarnings: number[];
	startMessage: string;
	progressMessage: string;
	winMessage: string;
	drawMessage: string;
	timeLeftMessage: string;
}

export function validateKillRace(c: Record<string, unknown>): KillRaceConfig {
	const target = int(c.target, KILL_RACE_DEFAULT_TARGET);
	if (target < KILL_RACE_MIN_TARGET || target > KILL_RACE_MAX_TARGET)
		throw new ApiError(
			400,
			`The kills to win go from ${KILL_RACE_MIN_TARGET} to ${KILL_RACE_MAX_TARGET}.`
		);
	const timeWarnings: number[] = [];
	const raw = Array.isArray(c.timeWarnings)
		? c.timeWarnings
		: c.timeWarnings === undefined
			? KILL_RACE_DEFAULT_TIME_WARNINGS
			: [];
	for (const v of raw) {
		const n = int(v, 0, 0, KILL_RACE_MAX_LIMIT_MINUTES);
		if (n >= 1 && !timeWarnings.includes(n)) timeWarnings.push(n);
	}
	if (timeWarnings.length > MAX_WARNINGS)
		throw new ApiError(400, `At most ${MAX_WARNINGS} times left to announce.`);
	timeWarnings.sort((a, b) => b - a);
	const text = (k: keyof typeof KILL_RACE_DEFAULTS) =>
		c[k] === undefined ? KILL_RACE_DEFAULTS[k] : str(c[k], 256);
	return {
		target,
		headshotsOnly: c.headshotsOnly === true,
		teamKillsSubtract: c.teamKillsSubtract === true,
		// a few classes of weapons at once: the whole hand-held list, and the vehicles beside it
		causes: causeTags(c.causes, 'weapon', 'Id.Item.Mosin', KILL_RACE_MAX_CAUSES),
		announceEvery: int(c.announceEvery, 25, 0, KILL_RACE_MAX_TARGET),
		timeLimitMinutes: int(c.timeLimitMinutes, 0, 0, KILL_RACE_MAX_LIMIT_MINUTES),
		timeWarnings,
		startMessage: text('startMessage'),
		progressMessage: text('progressMessage'),
		winMessage: text('winMessage'),
		drawMessage: text('drawMessage'),
		timeLeftMessage: text('timeLeftMessage')
	};
}

/** The fingerprint a rule's rows carry: an announcement decided under other settings is not sent. */
export const killRaceSettingsKey = (cfg: KillRaceConfig): string => settingsFingerprint(cfg);

/** Whether the rule says anything to players (and so needs Chat). */
export const killRaceSpeaks = (cfg: Partial<KillRaceConfig> | null | undefined): boolean =>
	!!cfg &&
	(Object.keys(KILL_RACE_DEFAULTS) as (keyof typeof KILL_RACE_DEFAULTS)[]).some(
		(k) => (cfg[k] === undefined ? KILL_RACE_DEFAULTS[k] : str(cfg[k])) !== ''
	);

// ---- the count ---------------------------------------------------------------------------------

/** One killer's kills in the match, as the database adds them up (suicides and the environment left out). */
export interface KillerLine {
	steamId: string;
	name: string;
	faction: string | null;
	/** kills of the other side */
	kills: number;
	/** of those, headshots */
	headshots: number;
	/** kills of their own side */
	teamKills: number;
}

export interface Tally {
	/** each side's count, highest first; sides the scoreboard lists start at 0 */
	sides: { faction: string; kills: number }[];
	/** the player with the most counted kills, if any */
	top: { name: string; kills: number } | null;
}

/** The sides' counts under the rule's settings, the scoreboard's factions included at 0. */
export function tally(cfg: KillRaceConfig, lines: KillerLine[], factions: string[] = []): Tally {
	const by = new Map<string, number>();
	for (const f of factions) if (f) by.set(f, 0);
	let top: Tally['top'] = null;
	for (const l of lines) {
		const own =
			(cfg.headshotsOnly ? l.headshots : l.kills) - (cfg.teamKillsSubtract ? l.teamKills : 0);
		if (l.faction) by.set(l.faction, (by.get(l.faction) ?? 0) + own);
		const counted = cfg.headshotsOnly ? l.headshots : l.kills;
		if (counted > 0 && (!top || counted > top.kills))
			top = { name: l.name || l.steamId, kills: counted };
	}
	const sides = [...by.entries()]
		.map(([faction, kills]) => ({ faction, kills: Math.max(0, kills) }))
		.sort((a, b) => b.kills - a.kills || a.faction.localeCompare(b.faction));
	return { sides, top };
}

/**
 * What counts, in words, for `{weapons}`: "kills", "headshots", "kills with Mosin Nagant, SV98", or
 * the first three weapons and how many more.
 */
export function countedWords(
	cfg: Partial<Pick<KillRaceConfig, 'headshotsOnly' | 'causes'>>
): string {
	const what = cfg.headshotsOnly ? 'headshots' : 'kills';
	const causes = cfg.causes ?? [];
	if (!causes.length) return what;
	const names = [...new Set(causes.map(causeLabel))];
	const shown = names.slice(0, 3).join(', ');
	return `${what} with ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`;
}

/** Whether a kill with this cause counts under the rule's weapons (every one when it names none). */
export function countsCause(cfg: Partial<Pick<KillRaceConfig, 'causes'>>, cause: string | null) {
	const causes = cfg.causes ?? [];
	if (!causes.length) return true;
	return !!cause && causes.some((c) => c.toLowerCase() === cause.toLowerCase());
}

/** "Valkyra 42 · Lonestar 38 · Manticore 30" */
export const standings = (t: Tally): string =>
	t.sides.map((s) => `${s.faction} ${s.kills}`).join(' · ');

/** The side ahead, or null for none (no kills, or a tie at the top). */
export function leader(t: Tally): { faction: string; kills: number } | null {
	const [first, second] = t.sides;
	if (!first || first.kills === 0) return null;
	if (second && second.kills === first.kills) return null;
	return first;
}

// ---- what is said and done ----------------------------------------------------------------------

/** What the rule has said in one match. */
export interface RaceMemory {
	/** the settings and the match it was kept for: either changing starts it over */
	key: string;
	match: string;
	/** the highest multiple of announceEvery announced */
	step: number;
	/** the race is decided (won, drawn or timed out): nothing more is said this match */
	decided: boolean;
	/** when the match's clock started (ms), and whether that is a guess until the feed says */
	clockFrom: number;
	clockGuessed: boolean;
	timeWarned: Set<number>;
	/** the last count read, for a look that has to decide without a batch */
	last: Tally | null;
}

export const newRaceMemory = (
	key: string,
	match: string,
	now: number,
	guessed: boolean
): RaceMemory => ({
	key,
	match,
	step: 0,
	decided: false,
	clockFrom: now,
	clockGuessed: guessed,
	timeWarned: new Set(),
	last: null
});

export type RaceNews =
	| { kind: 'progress'; tally: Tally }
	| { kind: 'win'; winner: string; kills: number; tally: Tally; why: 'target' | 'time' | 'match' }
	| { kind: 'draw'; tally: Tally; why: 'time' | 'match' }
	| { kind: 'time'; minutes: number; tally: Tally };

/**
 * A new count: the standings each time the leader passes a multiple of announceEvery (once, the
 * highest passed), and the win as a side reaches the target. A memory that has just been made (a
 * restart mid-match, a rule switched on) takes the steps already passed as said. Mutates `mem`.
 */
export function raceStep(
	cfg: KillRaceConfig,
	mem: RaceMemory,
	t: Tally,
	fresh = false
): RaceNews[] {
	mem.last = t;
	if (mem.decided) return [];
	const lead = t.sides[0]?.kills ?? 0;
	const step = cfg.announceEvery ? Math.floor(lead / cfg.announceEvery) : 0;
	if (lead >= cfg.target) {
		mem.decided = true;
		const w = t.sides[0];
		return [{ kind: 'win', winner: w.faction, kills: w.kills, tally: t, why: 'target' }];
	}
	if (fresh) {
		mem.step = step;
		return [];
	}
	if (step > mem.step) {
		mem.step = step;
		return [{ kind: 'progress', tally: t }];
	}
	return [];
}

/**
 * The clock at a look: the time left announced at each warning (once, the lowest reached), and at
 * the limit the side with the most kills wins (a tie is a draw). Mutates `mem`.
 */
export function raceClock(cfg: KillRaceConfig, mem: RaceMemory, now: number): RaceNews[] {
	if (!cfg.timeLimitMinutes || mem.decided || !mem.clockFrom) return [];
	const t = mem.last ?? { sides: [], top: null };
	const left = mem.clockFrom + cfg.timeLimitMinutes * 60_000 - now;
	if (left <= 0) {
		mem.decided = true;
		const w = leader(t);
		return [
			w
				? { kind: 'win', winner: w.faction, kills: w.kills, tally: t, why: 'time' }
				: { kind: 'draw', tally: t, why: 'time' }
		];
	}
	const reached = cfg.timeWarnings.filter(
		(w) => w < cfg.timeLimitMinutes && left <= w * 60_000 && !mem.timeWarned.has(w)
	);
	if (!reached.length) return [];
	for (const w of reached) mem.timeWarned.add(w);
	return [{ kind: 'time', minutes: Math.ceil(left / 60_000), tally: t }];
}

/** The game ended the match before the race was decided: it is told by the kills as they stood. */
export function raceAtMatchEnd(mem: RaceMemory): RaceNews[] {
	if (mem.decided || !mem.last) return [];
	mem.decided = true;
	const w = leader(mem.last);
	if (w) return [{ kind: 'win', winner: w.faction, kills: w.kills, tally: mem.last, why: 'match' }];
	return mem.last.sides.some((s) => s.kills > 0)
		? [{ kind: 'draw', tally: mem.last, why: 'match' }]
		: [];
}

/** A memory made mid-match is timed from then; the feed's match clock says when the match began. */
export function syncRaceClock(mem: RaceMemory, receivedAt: number, eventTimeS: number): void {
	if (!mem.clockGuessed || !Number.isFinite(eventTimeS) || eventTimeS < 0) return;
	mem.clockFrom = receivedAt - eventTimeS * 1000;
	mem.clockGuessed = false;
}

// ---- worker memory ------------------------------------------------------------------------------

const memories = new Map<string, { serverId: string; mem: RaceMemory }>();

/** The rule's memory for this match, made (and flagged fresh) when there is none for it. */
export function raceMemory(
	serverId: string,
	ruleId: string,
	key: string,
	match: string,
	now: number,
	guessed: boolean
): { mem: RaceMemory; fresh: boolean } {
	const kept = memories.get(ruleId);
	if (kept && kept.mem.key === key && kept.mem.match === match)
		return { mem: kept.mem, fresh: false };
	const mem = newRaceMemory(key, match, now, guessed);
	memories.set(ruleId, { serverId, mem });
	return { mem, fresh: true };
}

/** The rule's memory whatever match it is for, if its settings still hold. */
export const knownRace = (ruleId: string, key: string): RaceMemory | undefined => {
	const kept = memories.get(ruleId);
	return kept?.mem.key === key ? kept.mem : undefined;
};

/** Forgets one server's rules that are no longer on. */
export function keepRaces(serverId: string, live: Set<string>): void {
	for (const [id, k] of memories) if (k.serverId === serverId && !live.has(id)) memories.delete(id);
}

export function forgetRaces(): void {
	memories.clear();
}
