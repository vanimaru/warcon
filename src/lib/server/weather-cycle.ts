// The Weather cycle rule (kind `weather_cycle`). WARDOGS changes the time of day and weather of the
// match being played when asked (PUT /v1/world/lighting, Match control's setWeather): no map change,
// no restart. The rule asks while the server has its players on, going through its lightings in its
// own order, or picking one at random, and never the one the server shows already. When it asks is
// up to three moments, each with its own chance (a roll of the dice, 100% always): every few minutes,
// as the side ahead first reaches each of a list of scores in a match, and as a match reaches each of
// a list of minutes. A match's scores and minutes are kept in the rule's state with the map, so each
// is rolled once a match; a rule switched on mid-match takes those already passed as rolled.
// The next map starts on its rotation entry's own lighting, and the rule changes that at its next
// turn. At delivery the server's own list of lightings is read first, so one it does not offer (rain
// is allowed on some servers only, and read at startup) is kept as skipped rather than sent. No
// database here.
import { ApiError, int, str } from './http';
import { ACTIONS } from './actions';
import { settingsFingerprint } from './fingerprint';
import type { WardogsClient } from './rcon';
import { prettify } from '../format';
import type { CatalogItem } from '../types';

/** The outbox action that changes the weather for the rule (not in ACTIONS). */
export const WEATHER_CYCLE = 'weather_cycle';
export const WEATHER_DEFAULT_MINUTES = 30;
/** Any sooner and the weather flickers rather than changes. */
export const WEATHER_MIN_MINUTES = 5;
export const WEATHER_MAX_MINUTES = 1440;
/** A chance in percent: 100 changes every time, 0 never. */
export const WEATHER_DEFAULT_CHANCE = 100;
export const WEATHER_DEFAULT_EVENT_CHANCE = 50;
/** The scores and minutes a rule can list, each. */
const MAX_MOMENTS = 20;
export const WEATHER_MAX_SCORE = 10_000;
export const WEATHER_MAX_MATCH_MINUTES = 600;
/** A score or a minute that comes up this soon after a change does not change it again. */
export const WEATHER_EVENT_GAP_MS = 60_000;
/** More than the game lists (nine on Season 2). */
const MAX_LIGHTINGS = 20;
/** A lighting id as the game's catalog gives them ("DayLateRain"). */
const LIGHTING_ID = /^[A-Za-z0-9_.-]{1,100}$/;

export interface WeatherCycleConfig {
	/** lighting ids, in the order the rule goes through them */
	lightings: string[];
	/** every so many minutes (0: never), with this chance each time */
	everyMinutes: number;
	everyChance: number;
	/** the scores the side ahead reaches in a match, each rolled once with this chance */
	scoreSteps: number[];
	scoreChance: number;
	/** the minutes into a match, each rolled once with this chance */
	matchMinutes: number[];
	minutesChance: number;
	/** any of the others at random, rather than the next in order */
	random: boolean;
	/** changes only while at least this many are on */
	minPlayers: number;
}

export function validateWeatherCycle(c: Record<string, unknown>): WeatherCycleConfig {
	const lightings: string[] = [];
	for (const v of Array.isArray(c.lightings) ? c.lightings : []) {
		const id = str(v, 101);
		if (!LIGHTING_ID.test(id))
			throw new ApiError(
				400,
				`"${id.slice(0, 40)}" is not a lighting: use the ids the server lists, such as DayLateRain.`
			);
		if (!lightings.some((x) => same(x, id))) lightings.push(id);
	}
	if (lightings.length < 2)
		throw new ApiError(400, 'Pick at least two lightings to change between.');
	if (lightings.length > MAX_LIGHTINGS)
		throw new ApiError(400, `At most ${MAX_LIGHTINGS} lightings.`);
	const scoreSteps = moments(c.scoreSteps, WEATHER_MAX_SCORE, 'scores');
	const matchMinutes = moments(c.matchMinutes, WEATHER_MAX_MATCH_MINUTES, 'minutes into a match');
	const everyMinutes = int(c.everyMinutes, WEATHER_DEFAULT_MINUTES);
	// 0 switches the clock off, for a rule that changes on scores or minutes only
	const clockOff = everyMinutes === 0 && (scoreSteps.length > 0 || matchMinutes.length > 0);
	if (!clockOff && (everyMinutes < WEATHER_MIN_MINUTES || everyMinutes > WEATHER_MAX_MINUTES))
		throw new ApiError(
			400,
			everyMinutes === 0
				? 'With no scores or minutes into a match to change at, change the weather every 5 to 1440 minutes.'
				: `Change the weather every ${WEATHER_MIN_MINUTES} to ${WEATHER_MAX_MINUTES} minutes (0: never).`
		);
	return {
		lightings,
		everyMinutes,
		everyChance: int(c.everyChance, WEATHER_DEFAULT_CHANCE, 0, 100),
		scoreSteps,
		scoreChance: int(c.scoreChance, WEATHER_DEFAULT_EVENT_CHANCE, 0, 100),
		matchMinutes,
		minutesChance: int(c.minutesChance, WEATHER_DEFAULT_EVENT_CHANCE, 0, 100),
		random: c.random === true,
		minPlayers: int(c.minPlayers, 1, 0, 1000)
	};
}

/** A list of scores or minutes: whole numbers from 1 to `max`, each once, lowest first. */
function moments(raw: unknown, max: number, what: string): number[] {
	const out: number[] = [];
	for (const v of Array.isArray(raw) ? raw : []) {
		const n = int(v, 0, 0, max);
		if (n >= 1 && !out.includes(n)) out.push(n);
	}
	if (out.length > MAX_MOMENTS) throw new ApiError(400, `At most ${MAX_MOMENTS} ${what}.`);
	return out.sort((a, b) => a - b);
}

/** The fingerprint a rule's rows carry: a change decided under other settings is not sent. */
export const weatherCycleSettingsKey = (cfg: WeatherCycleConfig): string =>
	settingsFingerprint(cfg);

/** What the rule keeps between looks (the trigger row's state). */
export interface WeatherState {
	/** the place of the lighting it last put on */
	index?: number;
	/** when the clock last rolled (ms); absent on rows written before chances, then lastFiredAt */
	rolledAt?: number;
	/** the match the scores and minutes are rolled for: its map, when it began (ms; a guess for
	 *  one the rule came into midway), and the scores and minutes rolled */
	match?: { map: string; from: number; scores: number[]; minutes: number[] };
}

/** One roll of the dice: what it was for, its chance, and whether it came up. */
export interface WeatherRoll {
	why: 'every' | 'score' | 'minutes';
	/** the score or the minute reached (0 for the clock) */
	at: number;
	chance: number;
	hit: boolean;
}

export interface WeatherLook {
	now: number;
	/** the score of the side ahead */
	lead: number;
	map: string;
	/** the look saw a match end, so a new one begins */
	matchEnded: boolean;
	/** the game's match clock, when it sends one */
	matchSeconds: number | null;
	/** when the rule last changed the weather (ms), or null */
	lastFiredAt: number | null;
	players: number;
}

/** "the clock", "score 50", "10 min into the match": what a roll was for, in words. */
export const rollWords = (r: Pick<WeatherRoll, 'why' | 'at'>): string =>
	r.why === 'every' ? 'the clock' : r.why === 'score' ? `score ${r.at}` : `${r.at} min in`;

/**
 * What comes due at a look, and the dice rolled for it: the clock every `everyMinutes`, each score
 * of the list the side ahead reaches, and each minute into the match, once a match each (several
 * passed at once roll once, for the highest). Below the rule's player count nothing is rolled: the
 * clock waits, and the scores and minutes passed are marked as rolled. Whether to change is any
 * roll that came up; a score's or a minute's coming up too soon after a change does not count.
 * `dirty` says the state moved and is to be written.
 */
export function weatherStep(
	cfg: WeatherCycleConfig,
	raw: unknown,
	look: WeatherLook,
	rand: () => number = Math.random
): { state: WeatherState; rolls: WeatherRoll[]; change: boolean; dirty: boolean } {
	const was = (raw && typeof raw === 'object' ? raw : {}) as WeatherState;
	const state: WeatherState = { ...was };
	const rolls: WeatherRoll[] = [];
	let dirty = false;
	const enough = look.players >= cfg.minPlayers;
	const roll = (why: WeatherRoll['why'], at: number, chance: number) => {
		// a roll of 100 always comes up and of 0 never, whatever the dice
		const hit = chance >= 100 ? true : chance <= 0 ? false : rand() * 100 < chance;
		rolls.push({ why, at, chance, hit });
	};
	if (cfg.everyMinutes > 0 && enough) {
		const last =
			typeof was.rolledAt === 'number' && Number.isFinite(was.rolledAt)
				? was.rolledAt
				: look.lastFiredAt;
		if (last === null || look.now - last >= cfg.everyMinutes * 60_000) {
			roll('every', 0, cfg.everyChance);
			state.rolledAt = look.now;
			dirty = true;
		}
	}
	if (cfg.scoreSteps.length || cfg.matchMinutes.length) {
		const m = was.match;
		const valid =
			!!m &&
			typeof m.map === 'string' &&
			Number.isFinite(m.from) &&
			Array.isArray(m.scores) &&
			Array.isArray(m.minutes);
		// another match: one seen ending, another map, or a score rolled that the side ahead is now
		// below (the scores started again, the end unseen)
		const fresh =
			!valid || look.matchEnded || m!.map !== look.map || m!.scores.some((x) => x > look.lead);
		let match = valid ? { ...m!, scores: [...m!.scores], minutes: [...m!.minutes] } : null;
		if (fresh) {
			const from = look.matchEnded
				? look.now
				: look.matchSeconds !== null && Number.isFinite(look.matchSeconds) && look.matchSeconds >= 0
					? look.now - look.matchSeconds * 1000
					: look.now;
			// a match the rule comes into midway: what has passed is not rolled for
			match = {
				map: look.map,
				from,
				scores: look.matchEnded ? [] : cfg.scoreSteps.filter((x) => x <= look.lead),
				minutes: look.matchEnded
					? []
					: cfg.matchMinutes.filter((x) => look.now - from >= x * 60_000)
			};
			dirty = true;
		} else {
			const scores = cfg.scoreSteps.filter((x) => x <= look.lead && !match!.scores.includes(x));
			if (scores.length) {
				match!.scores.push(...scores);
				if (enough) roll('score', Math.max(...scores), cfg.scoreChance);
				dirty = true;
			}
			const minutes = cfg.matchMinutes.filter(
				(x) => look.now - match!.from >= x * 60_000 && !match!.minutes.includes(x)
			);
			if (minutes.length) {
				match!.minutes.push(...minutes);
				if (enough) roll('minutes', Math.max(...minutes), cfg.minutesChance);
				dirty = true;
			}
		}
		state.match = match!;
	}
	const soon = look.lastFiredAt !== null && look.now - look.lastFiredAt < WEATHER_EVENT_GAP_MS;
	const change = rolls.some((r) => r.hit && (r.why === 'every' || !soon));
	return { state, rolls, change, dirty };
}

/** Where the rule is in its list: the place of the lighting it last put on, -1 before the first. */
export const weatherCycleIndex = (state: unknown): number => {
	const i = (state as { index?: unknown } | null)?.index;
	return typeof i === 'number' && Number.isInteger(i) && i >= 0 ? i : -1;
};

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** "Day Late Rain": a lighting's name in the panel's own words, from its id. */
export const lightingName = (id: string): string => prettify(id) || id;

/**
 * The lighting the rule puts on next and its place in the list: in order, the one after the last
 * it put on (the top the first time), passing over the one the server shows; at random, any but the
 * one the server shows. Null only when the list holds nothing else.
 */
export function nextLighting(
	cfg: Pick<WeatherCycleConfig, 'lightings' | 'random'>,
	last: number,
	showing: string,
	rand: () => number = Math.random
): { index: number; lighting: string } | null {
	const n = cfg.lightings.length;
	if (cfg.random) {
		const others = cfg.lightings
			.map((lighting, index) => ({ index, lighting }))
			.filter((l) => !same(l.lighting, showing));
		return others.length
			? others[Math.min(others.length - 1, Math.floor(rand() * others.length))]
			: null;
	}
	for (let step = 1; step <= n; step++) {
		const index = (last + step) % n;
		if (!same(cfg.lightings[index], showing)) return { index, lighting: cfg.lightings[index] };
	}
	return null;
}

/**
 * The change, at delivery: the server's lightings read, and the rule's sent only when the server
 * lists it, under the id the server gives it (`skipped` otherwise: the outbox keeps the row, with
 * no audit row). The result is the panel's own words.
 */
export async function changeWeather(
	client: WardogsClient,
	params: Record<string, unknown>
): Promise<{ message: string; skipped?: true }> {
	const lighting = str(params.lighting, 100);
	const { lightings } = (await ACTIONS.lightings.run(client, {})) as { lightings: CatalogItem[] };
	const offered = lightings.find((l) => same(l.id, lighting));
	if (!offered)
		return {
			skipped: true,
			message: `Not sent: ${lightingName(lighting)} is not among the lightings this server lists.`
		};
	await ACTIONS.setWeather.run(client, { lighting: offered.id });
	return { message: `Changed the weather to ${lightingName(offered.id)}.` };
}
