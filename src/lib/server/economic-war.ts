// The Economic War rule (kind `economic_war`): a race to money on top of the game's own match. The
// game scores a side for holding the control zone and ends the match at its cap; the rule adds up
// the cash each side's players earn instead, and the first side to the rule's target wins: the
// rule announces it and ends the match (POST /v1/match/end, Match control). A time limit can end
// it sooner, the side that earned the most then winning; a match the game ends first is announced
// by the money as it stood.
//
// The game sends no event for money, only each player's cash on the player list, so the rule reads
// it at every look that fetched the list (every two seconds or so while people are on): a rise
// since the player's last look is earned, and goes to the side they are on at this look. Money
// spent (a vehicle, a loadout) lowers the cash and is not taken off, so buying does not cost a side
// its progress; a drop is also how the scoreboard starts a player's cash again (a reconnect, a new
// match), and either way the next rise counts from there. A player's first look only sets where
// they start from, and so does every look in the first seconds of a match, when the game hands out
// the starting cash. Players without a side earn for nobody.
//
// Kept in the worker's memory, and written to the rule's row (state) now and then with the match it
// is for, so a worker restart in the same match carries on from the last write. Pure here, but for
// that memory; triggers.ts acts on it at each look.
import { ApiError, int, str } from './http';
import { settingsFingerprint } from './fingerprint';
import { fmtCash } from '$lib/cash';
import { ECONOMIC_WAR_DEFAULTS } from '$lib/economic-war-defaults';
import type { Player } from '$lib/types';

export { ECONOMIC_WAR_DEFAULTS };

export const ECONOMIC_WAR_DEFAULT_TARGET = 30_000;
export const ECONOMIC_WAR_MIN_TARGET = 1_000;
export const ECONOMIC_WAR_MAX_TARGET = 10_000_000;
export const ECONOMIC_WAR_DEFAULT_STEP = 5_000;
export const ECONOMIC_WAR_MAX_LIMIT_MINUTES = 180;
export const ECONOMIC_WAR_DEFAULT_TIME_WARNINGS = [5, 1];
/** A match's first seconds: the game hands out the starting cash, which nobody earned. */
export const ECONOMIC_WAR_GRACE_MS = 30_000;
/** How often the count is written to the rule's row while it moves. */
export const ECONOMIC_WAR_SAVE_MS = 15_000;
/** The top earners kept in the row (the count of the sides is kept whole). */
const SAVED_EARNERS = 20;
const MAX_WARNINGS = 10;

export interface EconomicWarConfig {
	/** the cash a side must earn to win */
	target: number;
	/** the standings are announced each time the leader passes a multiple of this (0: never) */
	announceEvery: number;
	/** the match's time limit in minutes (0: none): the side that earned the most then wins */
	timeLimitMinutes: number;
	/** minutes left announced as the limit nears */
	timeWarnings: number[];
	startMessage: string;
	progressMessage: string;
	winMessage: string;
	drawMessage: string;
	timeLeftMessage: string;
}

export function validateEconomicWar(c: Record<string, unknown>): EconomicWarConfig {
	const target = int(c.target, ECONOMIC_WAR_DEFAULT_TARGET);
	if (target < ECONOMIC_WAR_MIN_TARGET || target > ECONOMIC_WAR_MAX_TARGET)
		throw new ApiError(
			400,
			`The cash to win goes from ${ECONOMIC_WAR_MIN_TARGET} to ${ECONOMIC_WAR_MAX_TARGET}.`
		);
	const timeWarnings: number[] = [];
	const raw = Array.isArray(c.timeWarnings)
		? c.timeWarnings
		: c.timeWarnings === undefined
			? ECONOMIC_WAR_DEFAULT_TIME_WARNINGS
			: [];
	for (const v of raw) {
		const n = int(v, 0, 0, ECONOMIC_WAR_MAX_LIMIT_MINUTES);
		if (n >= 1 && !timeWarnings.includes(n)) timeWarnings.push(n);
	}
	if (timeWarnings.length > MAX_WARNINGS)
		throw new ApiError(400, `At most ${MAX_WARNINGS} times left to announce.`);
	timeWarnings.sort((a, b) => b - a);
	const text = (k: keyof typeof ECONOMIC_WAR_DEFAULTS) =>
		c[k] === undefined ? ECONOMIC_WAR_DEFAULTS[k] : str(c[k], 256);
	return {
		target,
		announceEvery: int(c.announceEvery, ECONOMIC_WAR_DEFAULT_STEP, 0, ECONOMIC_WAR_MAX_TARGET),
		timeLimitMinutes: int(c.timeLimitMinutes, 0, 0, ECONOMIC_WAR_MAX_LIMIT_MINUTES),
		timeWarnings,
		startMessage: text('startMessage'),
		progressMessage: text('progressMessage'),
		winMessage: text('winMessage'),
		drawMessage: text('drawMessage'),
		timeLeftMessage: text('timeLeftMessage')
	};
}

/** The fingerprint a rule's rows carry: an announcement decided under other settings is not sent. */
export const economicWarSettingsKey = (cfg: EconomicWarConfig): string => settingsFingerprint(cfg);

/** Whether the rule says anything to players (and so needs Chat). */
export const economicWarSpeaks = (cfg: Partial<EconomicWarConfig> | null | undefined): boolean =>
	!!cfg &&
	(Object.keys(ECONOMIC_WAR_DEFAULTS) as (keyof typeof ECONOMIC_WAR_DEFAULTS)[]).some(
		(k) => (cfg[k] === undefined ? ECONOMIC_WAR_DEFAULTS[k] : str(cfg[k])) !== ''
	);

// ---- the count ---------------------------------------------------------------------------------

export interface EconTally {
	/** each side's earnings, highest first; the scoreboard's sides start at 0 */
	sides: { faction: string; cash: number }[];
	/** the player who earned the most, if anyone earned */
	top: { name: string; cash: number } | null;
}

/** What the rule keeps for one match. */
export interface EconMemory {
	/** the settings it was kept under: a change starts it over */
	key: string;
	/** names the match in the outbox's dedupe keys: `t` and when the memory began it */
	match: string;
	/** the panel's row of the match (matches.id), once read: the saved state is for it alone */
	dbMatch: number | null;
	/** the map the match is on; another map is another match, whether or not its end was seen */
	map: string;
	/** each side's earnings */
	sides: Map<string, number>;
	/** each player's earnings, under the name they last had */
	earners: Map<string, { name: string; cash: number }>;
	/** each player's cash at the last look they were on */
	last: Map<string, number>;
	/** rises before this time set where players start from and earn nothing */
	graceUntil: number;
	/** the highest multiple of announceEvery announced */
	step: number;
	/** won, drawn or timed out: nothing more is counted or said this match */
	decided: boolean;
	/** when the match's clock started (ms), and whether that is a guess (a memory made mid-match) */
	clockFrom: number;
	clockGuessed: boolean;
	timeWarned: Set<number>;
	/** moved since the last write to the row, and when that was */
	dirty: boolean;
	savedAt: number;
}

/**
 * A memory for a match. `boundary` says the match is just beginning (its end was seen), so the
 * first seconds' rises are the game's starting cash; a memory made mid-match only takes everyone's
 * cash as it stands at its first look.
 */
export const newEconMemory = (
	key: string,
	map: string,
	now: number,
	boundary: boolean
): EconMemory => ({
	key,
	match: `t${now}`,
	dbMatch: null,
	map,
	sides: new Map(),
	earners: new Map(),
	last: new Map(),
	graceUntil: boundary ? now + ECONOMIC_WAR_GRACE_MS : 0,
	step: 0,
	decided: false,
	clockFrom: now,
	clockGuessed: !boundary,
	timeWarned: new Set(),
	dirty: false,
	savedAt: now
});

/**
 * One look at the player list: each player's rise since their last look goes to the side they are
 * on (a team on the scoreboard), and players gone from the list are forgotten (what they earned
 * stays with their side). Returns whether anything was earned. Mutates `mem`.
 */
export function econLook(
	mem: EconMemory,
	players: Pick<Player, 'steamId' | 'name' | 'faction' | 'cash'>[],
	teams: readonly string[],
	now: number
): boolean {
	const on = new Set<string>();
	let earned = false;
	const counting = !mem.decided && now >= mem.graceUntil;
	for (const p of players) {
		if (!p.steamId) continue;
		on.add(p.steamId);
		const cash = Number(p.cash);
		if (!Number.isFinite(cash)) continue;
		const prev = mem.last.get(p.steamId);
		mem.last.set(p.steamId, cash);
		if (prev === undefined || !counting) continue;
		const rise = cash - prev;
		if (rise <= 0 || !p.faction || !teams.includes(p.faction)) continue;
		mem.sides.set(p.faction, (mem.sides.get(p.faction) ?? 0) + rise);
		const e = mem.earners.get(p.steamId);
		mem.earners.set(p.steamId, { name: p.name || p.steamId, cash: (e?.cash ?? 0) + rise });
		earned = true;
	}
	for (const id of mem.last.keys()) if (!on.has(id)) mem.last.delete(id);
	if (earned) mem.dirty = true;
	return earned;
}

/** Everyone's last cash forgotten: the next look sets where they start from (an outage, say). */
export const econRebase = (mem: EconMemory): void => mem.last.clear();

/** The sides' earnings, the scoreboard's teams included at 0, and the top earner. */
export function econTally(mem: EconMemory, teams: readonly string[] = []): EconTally {
	const by = new Map<string, number>();
	for (const f of teams) if (f) by.set(f, 0);
	for (const [f, n] of mem.sides) by.set(f, (by.get(f) ?? 0) + n);
	let top: EconTally['top'] = null;
	for (const e of mem.earners.values())
		if (e.cash > 0 && (!top || e.cash > top.cash)) top = { name: e.name, cash: e.cash };
	const sides = [...by.entries()]
		.map(([faction, cash]) => ({ faction, cash: Math.max(0, Math.round(cash)) }))
		.sort((a, b) => b.cash - a.cash || a.faction.localeCompare(b.faction));
	return { sides, top };
}

/** "Valkyra $12,400 · Lonestar $9,850 · Manticore $7,100" */
export const econStandings = (t: EconTally): string =>
	t.sides.map((s) => `${s.faction} ${fmtCash(s.cash)}`).join(' · ');

/** The side ahead, or null for none (nothing earned, or a tie at the top). */
export function econLeader(t: EconTally): { faction: string; cash: number } | null {
	const [first, second] = t.sides;
	if (!first || first.cash === 0) return null;
	if (second && second.cash === first.cash) return null;
	return first;
}

// ---- what is said and done ----------------------------------------------------------------------

export type EconNews =
	| { kind: 'progress'; tally: EconTally }
	| {
			kind: 'win';
			winner: string;
			cash: number;
			tally: EconTally;
			why: 'target' | 'time' | 'match';
	  }
	| { kind: 'draw'; tally: EconTally; why: 'time' | 'match' }
	| { kind: 'time'; minutes: number; tally: EconTally };

/**
 * After a look: the standings each time the leader passes a multiple of announceEvery (once, the
 * highest passed), and the win as a side reaches the target. A memory restored or made mid-match
 * (`fresh`) takes the steps already passed as said. Mutates `mem`.
 */
export function econStep(
	cfg: EconomicWarConfig,
	mem: EconMemory,
	t: EconTally,
	fresh = false
): EconNews[] {
	if (mem.decided) return [];
	const lead = t.sides[0]?.cash ?? 0;
	const step = cfg.announceEvery ? Math.floor(lead / cfg.announceEvery) : 0;
	if (lead >= cfg.target) {
		mem.decided = true;
		mem.dirty = true;
		const w = t.sides[0];
		return [{ kind: 'win', winner: w.faction, cash: w.cash, tally: t, why: 'target' }];
	}
	if (fresh) {
		mem.step = Math.max(mem.step, step);
		return [];
	}
	if (step > mem.step) {
		mem.step = step;
		mem.dirty = true;
		return [{ kind: 'progress', tally: t }];
	}
	return [];
}

/**
 * The clock at a look: the time left announced at each warning (once, the lowest reached), and at
 * the limit the side that earned the most wins (a tie is a draw). Mutates `mem`.
 */
export function econClock(
	cfg: EconomicWarConfig,
	mem: EconMemory,
	t: EconTally,
	now: number
): EconNews[] {
	if (!cfg.timeLimitMinutes || mem.decided || !mem.clockFrom) return [];
	const left = mem.clockFrom + cfg.timeLimitMinutes * 60_000 - now;
	if (left <= 0) {
		mem.decided = true;
		mem.dirty = true;
		const w = econLeader(t);
		return [
			w
				? { kind: 'win', winner: w.faction, cash: w.cash, tally: t, why: 'time' }
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

/** The game ended the match before the war was decided: it is told by the money as it stood. */
export function econAtMatchEnd(mem: EconMemory, t: EconTally): EconNews[] {
	if (mem.decided) return [];
	mem.decided = true;
	const w = econLeader(t);
	if (w) return [{ kind: 'win', winner: w.faction, cash: w.cash, tally: t, why: 'match' }];
	return t.sides.some((s) => s.cash > 0) ? [{ kind: 'draw', tally: t, why: 'match' }] : [];
}

/** A memory made mid-match is timed from then; the game's match clock, when it sends one, says
 *  when the match began. */
export function syncEconClock(mem: EconMemory, now: number, matchSeconds: number | null): void {
	if (!mem.clockGuessed || matchSeconds === null || !Number.isFinite(matchSeconds)) return;
	if (matchSeconds < 0) return;
	mem.clockFrom = now - matchSeconds * 1000;
	mem.clockGuessed = false;
}

// ---- the row ------------------------------------------------------------------------------------

/** What the rule's row holds between restarts: the count of one match of the panel's. */
export interface EconSaved {
	v: 1;
	match: string;
	dbMatch: number;
	map: string;
	sides: [string, number][];
	earners: [string, string, number][];
	step: number;
	decided: boolean;
	clockFrom: number;
	clockGuessed: boolean;
	timeWarned: number[];
}

export function econSaved(mem: EconMemory, dbMatch: number): EconSaved {
	return {
		v: 1,
		match: mem.match,
		dbMatch,
		map: mem.map,
		sides: [...mem.sides.entries()].map(([f, n]) => [f, Math.round(n)]),
		earners: [...mem.earners.entries()]
			.sort((a, b) => b[1].cash - a[1].cash)
			.slice(0, SAVED_EARNERS)
			.map(([id, e]) => [id, e.name, Math.round(e.cash)]),
		step: mem.step,
		decided: mem.decided,
		clockFrom: mem.clockFrom,
		clockGuessed: mem.clockGuessed,
		timeWarned: [...mem.timeWarned]
	};
}

/**
 * Takes up a saved count when it is for this match (the panel's open match, on the same map) and
 * these settings' memory has nothing of its own yet. Returns whether it did. Mutates `mem`.
 */
export function econRestore(mem: EconMemory, saved: unknown, dbMatch: number | null): boolean {
	const s = saved as Partial<EconSaved> | null;
	if (!s || s.v !== 1 || dbMatch === null || s.dbMatch !== dbMatch || s.map !== mem.map)
		return false;
	if (typeof s.match !== 'string' || !Array.isArray(s.sides)) return false;
	mem.match = s.match;
	mem.dbMatch = dbMatch;
	mem.sides = new Map(
		s.sides
			.filter((e): e is [string, number] => Array.isArray(e) && typeof e[0] === 'string')
			.map(([f, n]) => [f, Math.max(0, Number(n) || 0)])
	);
	mem.earners = new Map(
		(Array.isArray(s.earners) ? s.earners : [])
			.filter(
				(e): e is [string, string, number] =>
					Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string'
			)
			.map(([id, name, n]) => [id, { name, cash: Math.max(0, Number(n) || 0) }])
	);
	mem.step = Math.max(0, Number(s.step) || 0);
	mem.decided = s.decided === true;
	if (Number.isFinite(s.clockFrom) && (s.clockFrom as number) > 0) {
		mem.clockFrom = s.clockFrom as number;
		mem.clockGuessed = s.clockGuessed === true;
	}
	mem.timeWarned = new Set(
		(Array.isArray(s.timeWarned) ? s.timeWarned : []).filter((n): n is number => Number.isFinite(n))
	);
	return true;
}

// ---- worker memory ------------------------------------------------------------------------------

const memories = new Map<string, { serverId: string; mem: EconMemory }>();

/** The rule's memory under these settings, if it has one. */
export const knownEcon = (ruleId: string, key: string): EconMemory | undefined => {
	const kept = memories.get(ruleId);
	return kept?.mem.key === key ? kept.mem : undefined;
};

export function keepEcon(ruleId: string, serverId: string, mem: EconMemory): void {
	memories.set(ruleId, { serverId, mem });
}

/** Forgets one server's rules that are no longer on. */
export function keepEcons(serverId: string, live: Set<string>): void {
	for (const [id, k] of memories) if (k.serverId === serverId && !live.has(id)) memories.delete(id);
}

export function forgetEcons(): void {
	memories.clear();
}
