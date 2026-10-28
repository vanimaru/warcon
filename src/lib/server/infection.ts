// The Infection rule (kind `infection`): a game mode built from the kill feed and the move without the
// kill. Each round starts with a few players on the infected side and everyone else on the survivors'
// side: one faction of the rule's choosing, or (the default) every faction but the infected's, so on a
// full server of three factions only the first infected move at the start.
//
// The game's own win stands: a side scores while it has more players than the others in the control
// zone, and the first to the cap wins. The rule plays into it rather than against it: the infected
// start few and cannot hold the zone, so the survivors' sides score first; every kill an infected
// player makes moves a survivor across, until the infected outnumber them in the zone and their side
// races to the cap. So the survivors win by reaching the cap before the infection takes the zone, and
// the infection by reaching it first, or by leaving nobody uninfected. As the match ends the rule
// says which, in its own words, with who infected the most.
//
// The game has no time limit of its own, so the rule can keep one: survivors who hold out until it
// runs out win, whatever the scores, and the rule ends the match then (POST /v1/match/end, Match
// control), with the time left announced on the way. A survivor killed by an infected player joins the infected (moved as they lie dead, so they
// respawn on that side); the round is the infected's once nobody is left, and survivors last as long
// as they can. A new match starts a new round.
//
// What the rule keeps, it keeps in the worker's memory, per rule: who is infected this round, and
// when each player was last asked to move. A restart or a handover forgets it, and the next look
// takes the round as the server shows it (everyone on the infected side infected), so a restart
// never reshuffles a match in play. The decisions here are pure; triggers.ts (each look) and
// feed-events.ts (each kill batch) turn them into actions. No database here.
import { ApiError, int, str } from './http';
import { settingsFingerprint } from './fingerprint';
import { INFECTION_DEFAULTS } from '$lib/infection-defaults';

export { INFECTION_DEFAULTS };

/** Players who pick a side this soon after a round starts still count as its survivors. */
export const INFECTION_LATE_MS = 60_000;
/** A player asked to move and still on the wrong side is asked again after this long. */
export const INFECTION_REASK_MS = 30_000;
/** After a match ends, the round starts once most players have picked a side, or after this long. */
export const INFECTION_SETUP_WAIT_MS = 45_000;
/** The share of the players on that must have picked a side for the round to start before the wait. */
export const INFECTION_PICKED_SHARE = 0.75;
/** Moves a look sends, as Team balance does: the game takes a few a second. */
export const INFECTION_MAX_MOVES_PER_LOOK = 6;
/** The most players a round starts infected, whatever the count or share says. */
export const INFECTION_MAX_PATIENTS = 30;
/** The survivor counts announced by default as a round goes (a full server starts near 90). */
export const INFECTION_DEFAULT_MILESTONES = [25, 10, 5];
const MAX_MILESTONES = 10;
/** The longest round the rule times, in minutes. */
export const INFECTION_MAX_LIMIT_MINUTES = 180;
/** The minutes left announced by default as a timed round runs out. */
export const INFECTION_DEFAULT_TIME_WARNINGS = [5, 1];

export interface InfectionConfig {
	/** the faction the infected play on */
	infectedFaction: string;
	/** the faction the survivors play on, players on any other side moved here at the start; empty:
	 *  every faction but the infected's, where survivors stay on the side they picked */
	survivorFaction: string;
	/** how many players at least start each round infected (picked at random) */
	startInfected: number;
	/** and one more for every this many players with a side (0: the count alone), so a full server
	 *  starts with more than a quiet one */
	perPlayers: number;
	/** survivor counts announced once a round as the survivors fall to them (fewLeftMessage) */
	milestones: number[];
	/** a round starts only with at least this many on */
	minPlayers: number;
	/** broadcast when a round starts; `{patients}` names the first infected */
	startMessage: string;
	/** whispered to a survivor as they are infected; `{killer}` infected them */
	infectWhisper: string;
	/** broadcast at every infection; `{name}` the newly infected, `{killer}` who infected them */
	infectBroadcast: string;
	/** broadcast as the survivors fall to each milestone; `{survivors}` says how many */
	fewLeftMessage: string;
	/** broadcast once a round when one survivor is left; `{name}` is them */
	lastSurvivorMessage: string;
	/** broadcast when nobody is left uninfected */
	allInfectedMessage: string;
	/** broadcast as the match ends with a survivors' side ahead (on the game's scores) */
	survivorsWinMessage: string;
	/** broadcast as the match ends with the infected ahead, or nobody left uninfected */
	infectedWinMessage: string;
	/** end the match once everyone is infected, so the next round starts on the next map */
	endMatch: boolean;
	/** the round's time limit in minutes (0: none): survivors left when it runs out win, and the
	 *  match is ended */
	timeLimitMinutes: number;
	/** minutes left announced as the limit nears (timeLeftMessage) */
	timeWarnings: number[];
	/** broadcast as the time left falls to each warning; `{minutes}` says how many */
	timeLeftMessage: string;
}

const FACTION = /^[A-Za-z0-9 _.'-]{1,40}$/;

export function validateInfection(c: Record<string, unknown>): InfectionConfig {
	const infectedFaction = str(c.infectedFaction, 41);
	const survivorFaction = str(c.survivorFaction, 41);
	if (!FACTION.test(infectedFaction))
		throw new ApiError(400, 'Pick the infected faction, as the game names it (Manticore, say).');
	if (survivorFaction && !FACTION.test(survivorFaction))
		throw new ApiError(
			400,
			'Pick the survivors’ faction as the game names it, or leave it empty for every other faction.'
		);
	if (same(infectedFaction, survivorFaction))
		throw new ApiError(400, 'The infected and the survivors need two different factions.');
	const milestones: number[] = [];
	const raw = Array.isArray(c.milestones)
		? c.milestones
		: c.milestones === undefined
			? INFECTION_DEFAULT_MILESTONES
			: [];
	for (const v of raw) {
		const n = int(v, 0, 0, 1000);
		if (n >= 2 && !milestones.includes(n)) milestones.push(n);
	}
	if (milestones.length > MAX_MILESTONES)
		throw new ApiError(400, `At most ${MAX_MILESTONES} survivor counts to announce.`);
	milestones.sort((a, b) => b - a);
	const timeLimitMinutes = int(c.timeLimitMinutes, 0, 0, INFECTION_MAX_LIMIT_MINUTES);
	const timeWarnings: number[] = [];
	const rawWarnings = Array.isArray(c.timeWarnings)
		? c.timeWarnings
		: c.timeWarnings === undefined
			? INFECTION_DEFAULT_TIME_WARNINGS
			: [];
	for (const v of rawWarnings) {
		const n = int(v, 0, 0, INFECTION_MAX_LIMIT_MINUTES);
		if (n >= 1 && !timeWarnings.includes(n)) timeWarnings.push(n);
	}
	if (timeWarnings.length > MAX_MILESTONES)
		throw new ApiError(400, `At most ${MAX_MILESTONES} times left to announce.`);
	timeWarnings.sort((a, b) => b - a);
	const text = (k: keyof typeof INFECTION_DEFAULTS) =>
		c[k] === undefined ? INFECTION_DEFAULTS[k] : str(c[k], 256);
	return {
		infectedFaction,
		survivorFaction,
		startInfected: int(c.startInfected, 1, 1, INFECTION_MAX_PATIENTS),
		perPlayers: int(c.perPlayers, 10, 0, 100),
		milestones,
		minPlayers: int(c.minPlayers, 6, 2, 1000),
		startMessage: text('startMessage'),
		infectWhisper: text('infectWhisper'),
		infectBroadcast: text('infectBroadcast'),
		fewLeftMessage: text('fewLeftMessage'),
		lastSurvivorMessage: text('lastSurvivorMessage'),
		allInfectedMessage: text('allInfectedMessage'),
		survivorsWinMessage: text('survivorsWinMessage'),
		infectedWinMessage: text('infectedWinMessage'),
		endMatch: c.endMatch === true,
		timeLimitMinutes,
		timeWarnings,
		timeLeftMessage: text('timeLeftMessage')
	};
}

/** The fingerprint a rule's rows carry: a move decided under other settings is not sent. */
export const infectionSettingsKey = (cfg: InfectionConfig): string => settingsFingerprint(cfg);

/** Whether the rule says anything to players (and so needs Chat). */
export const infectionSpeaks = (cfg: Partial<InfectionConfig> | null | undefined): boolean =>
	!!cfg &&
	(Object.keys(INFECTION_DEFAULTS) as (keyof typeof INFECTION_DEFAULTS)[]).some(
		(k) => (cfg[k] === undefined ? INFECTION_DEFAULTS[k] : str(cfg[k])) !== ''
	);

export const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
	(a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();

export type InfectionRole = 'infected' | 'survivor';
/**
 * adopt: no round known (a new or edited rule, a restart): the next look takes what the server shows.
 * waiting: a new match, or no infected on: the round starts once the players are in.
 * running: the round is on. over: everyone is infected, until the match ends.
 */
export type InfectionPhase = 'adopt' | 'waiting' | 'running' | 'over';

export interface InfectionMemory {
	/** the settings the memory was kept under: an edit starts it over */
	key: string;
	phase: InfectionPhase;
	/** the round, as the time it began (ms): each round's actions are told apart by it, also across
	 *  a worker restart, which starts the count over */
	round: number;
	roles: Map<string, InfectionRole>;
	/** when each player was last asked to move */
	askedAt: Map<string, number>;
	/** players seen on their side this round: only they can switch sides of their own accord (a
	 *  player still waiting for their first move is not switching) */
	placed: Set<string>;
	startedAt: number;
	/** the first look of a wait with enough players on; 0 while there are not */
	waitingSince: number;
	lastSurvivorTold: boolean;
	/** the milestones announced this round, and those passed before the round could (a round that
	 *  starts with 8 survivors announces no 10) */
	milestonesTold: Set<number>;
	/** this round's infections by each infected player, for the round's top infector */
	infectedBy: Map<string, { name: string; count: number }>;
	/** the sides as the last look with a player list saw them (the list empties as a match ends) */
	lastCounts: { infected: number; survivors: number };
	/** when the round's clock started (ms): its start, or for a round taken over after a restart the
	 *  moment it was taken, until the kill feed's match clock says better (clockGuessed) */
	clockFrom: number;
	clockGuessed: boolean;
	/** the time limit has run out: the match is being ended, and the survivors have won */
	timeUp: boolean;
	/** the warnings of time left announced this round, and those passed before they could be */
	timeWarned: Set<number>;
}

export const newInfectionMemory = (key: string): InfectionMemory => ({
	key,
	phase: 'adopt',
	round: 0,
	roles: new Map(),
	askedAt: new Map(),
	placed: new Set(),
	startedAt: 0,
	waitingSince: 0,
	lastSurvivorTold: false,
	milestonesTold: new Set(),
	infectedBy: new Map(),
	lastCounts: { infected: 0, survivors: 0 },
	clockFrom: 0,
	clockGuessed: false,
	timeUp: false,
	timeWarned: new Set()
});

export interface InfectionPlayer {
	steamId: string;
	name: string;
	faction: string | null;
}

export interface InfectionMove {
	steamId: string;
	name: string;
	from: string;
	to: string;
	/** start: the round's sides; infected: killed by the infection; back: off the side they belong
	 *  on; late: joined the round late, so infected */
	why: 'start' | 'infected' | 'back' | 'late';
}

export type InfectionNews =
	| { kind: 'start'; patients: InfectionPlayer[] }
	| { kind: 'few'; survivors: number }
	| { kind: 'last'; survivor: InfectionPlayer }
	| { kind: 'all' }
	| { kind: 'time'; minutes: number }
	| { kind: 'timeup' }
	| {
			kind: 'result';
			/** true: the infection won; false: the survivors; null: nobody ahead (a tie, no score) */
			infectedWon: boolean | null;
			/** the survivors won by holding out until the time limit */
			timeUp: boolean;
			/** the faction ahead on the game's scores, if any */
			winner: string | null;
			infected: number;
			survivors: number;
			top: { name: string; count: number } | null;
	  };

export interface InfectionLook {
	moves: InfectionMove[];
	news: InfectionNews[];
	/** what the rule's row says, when it has something new to say */
	result: string | null;
}

const nextRound = (mem: InfectionMemory, now: number) => Math.max(now, mem.round + 1);

/** The sides survivors play on in a match with these factions. */
export const survivorSides = (cfg: InfectionConfig, factions: string[]): string[] =>
	cfg.survivorFaction
		? [cfg.survivorFaction]
		: factions.filter((f) => f && !same(f, cfg.infectedFaction));

/** How many start a round infected among this many players with a side: never all of them. */
export const patientCount = (cfg: InfectionConfig, picked: number): number =>
	Math.max(
		0,
		Math.min(
			INFECTION_MAX_PATIENTS,
			picked - 1,
			Math.max(cfg.startInfected, cfg.perPlayers ? Math.floor(picked / cfg.perPlayers) : 0)
		)
	);

/** Picks `n` of `from` at random (rand in [0, 1)). */
export function pickRandom<T>(from: T[], n: number, rand: () => number = Math.random): T[] {
	const pool = from.slice();
	const out: T[] = [];
	while (out.length < n && pool.length)
		out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
	return out;
}

/**
 * One look at the server for the rule: the round's start, the moves that keep everyone on the side
 * their role says (a survivor who switched to the infected side themselves is infected; anyone else
 * off their side is put back), and the round's news. Mutates `mem`.
 */
export function infectionLook(
	cfg: InfectionConfig,
	mem: InfectionMemory,
	input: {
		players: InfectionPlayer[];
		/** the factions of the match being played */
		factions: string[];
		matchEnded: boolean;
		/** the faction ahead as the match ended (the game's result when it sent one) */
		winner?: string | null;
		now: number;
		perLook?: number;
		rand?: () => number;
	}
): InfectionLook {
	const { players, factions, now } = input;
	const out: InfectionLook = { moves: [], news: [], result: null };
	if (input.matchEnded) {
		const result = roundResult(cfg, mem, input.winner ?? null);
		if (result) {
			out.news.push(result);
			out.result =
				result.infectedWon === null
					? 'Match over: no side ahead'
					: result.infectedWon
						? 'Match over: the infection won'
						: 'Match over: the survivors won';
		}
		mem.phase = 'waiting';
		mem.roles.clear();
		mem.askedAt.clear();
		mem.placed.clear();
		mem.waitingSince = 0;
		mem.lastSurvivorTold = false;
		mem.milestonesTold.clear();
		mem.infectedBy.clear();
		mem.lastCounts = { infected: 0, survivors: 0 };
		mem.timeUp = false;
		mem.timeWarned.clear();
		mem.clockFrom = 0;
	}
	const missing = [cfg.infectedFaction, cfg.survivorFaction].filter(
		(f) => f && !factions.some((x) => same(x, f))
	);
	if (missing.length) {
		out.result ??= `Waiting: this match has no ${missing.join(' or ')} faction`;
		return out;
	}
	const sides = survivorSides(cfg, factions);
	if (!sides.length) {
		out.result ??= 'Waiting: this match has no faction for the survivors';
		return out;
	}
	const picked = players.filter((p) => p.faction);
	const enough = players.length >= cfg.minPlayers;

	if (mem.phase === 'adopt') {
		if (!enough || !picked.length) {
			out.result ??= `Waiting for ${cfg.minPlayers} players`;
			return out;
		}
		// What the server shows is the round: everyone on the infected side is infected.
		for (const p of picked)
			mem.roles.set(p.steamId, same(p.faction, cfg.infectedFaction) ? 'infected' : 'survivor');
		mem.startedAt = 0;
		mem.clockFrom = now;
		mem.clockGuessed = true;
		mem.round = nextRound(mem, now);
		mem.phase = [...mem.roles.values()].includes('infected') ? 'running' : 'waiting';
		passMilestones(cfg, mem, roundCounts(mem, players).survivors);
		if (mem.phase === 'running') out.result = roundLine(mem, players);
	}

	if (mem.phase === 'waiting') {
		if (!enough || picked.length < 2) {
			mem.waitingSince = 0;
			out.result ??= `Waiting for ${cfg.minPlayers} players`;
			return out;
		}
		if (!mem.waitingSince) mem.waitingSince = now;
		const ready =
			picked.length >= players.length * INFECTION_PICKED_SHARE ||
			now - mem.waitingSince >= INFECTION_SETUP_WAIT_MS;
		if (!ready) return out;
		const patients = pickRandom(picked, patientCount(cfg, picked.length), input.rand);
		mem.roles.clear();
		mem.askedAt.clear();
		mem.placed.clear();
		const sick = new Set(patients.map((p) => p.steamId));
		for (const p of picked) mem.roles.set(p.steamId, sick.has(p.steamId) ? 'infected' : 'survivor');
		mem.phase = 'running';
		mem.round = nextRound(mem, now);
		mem.startedAt = now;
		mem.waitingSince = 0;
		mem.lastSurvivorTold = false;
		mem.milestonesTold.clear();
		mem.infectedBy.clear();
		mem.clockFrom = now;
		mem.clockGuessed = false;
		mem.timeUp = false;
		mem.timeWarned.clear();
		passMilestones(cfg, mem, picked.length - patients.length);
		out.news.push({ kind: 'start', patients });
		out.result = `Round started: ${patients.map((p) => p.name || p.steamId).join(', ')} infected`;
	}

	// running or over: keep everyone on their side. A survivor off the survivors' sides goes to the
	// one with the fewest survivors, counted as the moves are decided.
	const perLook = Math.max(1, input.perLook ?? INFECTION_MAX_MOVES_PER_LOOK);
	const onSide = new Map(sides.map((f) => [f, 0]));
	const sideOf = (faction: string | null) => sides.find((f) => same(f, faction));
	for (const p of picked) {
		const side = sideOf(p.faction);
		if (side && mem.roles.get(p.steamId) === 'survivor') onSide.set(side, onSide.get(side)! + 1);
	}
	const lightest = () => [...onSide.entries()].reduce((a, b) => (b[1] < a[1] ? b : a))[0];
	for (const p of picked) {
		let role = mem.roles.get(p.steamId);
		let late = false;
		if (!role) {
			// A player new to the round: a survivor at its start, infected after.
			role =
				mem.phase === 'running' && now - mem.startedAt < INFECTION_LATE_MS
					? 'survivor'
					: 'infected';
			late = role === 'infected';
			mem.roles.set(p.steamId, role);
		} else if (
			role === 'survivor' &&
			mem.placed.has(p.steamId) &&
			same(p.faction, cfg.infectedFaction)
		) {
			// joined the infected of their own accord
			role = 'infected';
			mem.roles.set(p.steamId, role);
		}
		const to = role === 'infected' ? cfg.infectedFaction : (sideOf(p.faction) ?? lightest());
		if (same(p.faction, to)) {
			mem.askedAt.delete(p.steamId);
			mem.placed.add(p.steamId);
			continue;
		}
		const asked = mem.askedAt.get(p.steamId);
		if (asked !== undefined && now - asked < INFECTION_REASK_MS) continue;
		if (out.moves.length >= perLook) continue;
		mem.askedAt.set(p.steamId, now);
		if (role === 'survivor') onSide.set(to, (onSide.get(to) ?? 0) + 1);
		out.moves.push({
			steamId: p.steamId,
			name: p.name || p.steamId,
			from: p.faction ?? '',
			to,
			why: late
				? 'late'
				: mem.startedAt && now - mem.startedAt < INFECTION_LATE_MS
					? 'start'
					: 'back'
		});
	}
	if (picked.length) mem.lastCounts = roundCounts(mem, players);
	out.news.push(...roundNews(cfg, mem, players));
	const clock = timeNews(cfg, mem, now);
	out.news.push(...clock);
	if (clock.some((n) => n.kind === 'timeup')) out.result = 'Time is up: the survivors held out';
	if (!out.result && out.news.length) out.result = roundLine(mem, players);
	return out;
}

/**
 * How a round came out as its match ended, in the infection's terms, or null when no round was on.
 * Nobody left uninfected is the infection's win whatever the scores say (an ended match is led by
 * whoever scored most, which can be a survivors' side); otherwise the game's leader decides.
 */
export function roundResult(
	cfg: InfectionConfig,
	mem: InfectionMemory,
	winner: string | null
): Extract<InfectionNews, { kind: 'result' }> | null {
	if (mem.phase !== 'running' && mem.phase !== 'over') return null;
	// held out until the time ran out: the survivors', whoever led on points (a survivors' side is
	// named as the winner only when it led)
	if (mem.timeUp && mem.phase === 'running') {
		let top: { name: string; count: number } | null = null;
		for (const t of mem.infectedBy.values()) if (!top || t.count > top.count) top = t;
		return {
			kind: 'result',
			infectedWon: false,
			timeUp: true,
			winner: winner && !same(winner, cfg.infectedFaction) ? winner : null,
			infected: mem.lastCounts.infected,
			survivors: mem.lastCounts.survivors,
			top
		};
	}
	const infectedWon =
		mem.phase === 'over' ? true : winner ? same(winner, cfg.infectedFaction) : null;
	let top: { name: string; count: number } | null = null;
	for (const t of mem.infectedBy.values()) if (!top || t.count > top.count) top = t;
	return {
		kind: 'result',
		infectedWon,
		timeUp: false,
		winner,
		infected: mem.lastCounts.infected,
		survivors: mem.phase === 'over' ? 0 : mem.lastCounts.survivors,
		top
	};
}

/**
 * The kills of one batch, in the order the game played them: a survivor killed by an infected
 * player is infected, and moved at once (they are dead, so they respawn on the infected side).
 * Mutates `mem`; nothing happens unless a round is running.
 */
export function infectionKills(
	cfg: InfectionConfig,
	mem: InfectionMemory,
	kills: {
		eventId: string;
		killer: InfectionPlayer | null;
		victim: InfectionPlayer;
		suicide: boolean;
	}[],
	now: number
): { infected: { victim: InfectionPlayer; killer: InfectionPlayer; eventId: string }[] } {
	const infected: { victim: InfectionPlayer; killer: InfectionPlayer; eventId: string }[] = [];
	if (mem.phase !== 'running' || mem.timeUp) return { infected };
	for (const k of kills) {
		if (!k.killer || k.suicide || k.killer.steamId === k.victim.steamId) continue;
		if (mem.roles.get(k.killer.steamId) !== 'infected') continue;
		if (mem.roles.get(k.victim.steamId) !== 'survivor') continue;
		mem.roles.set(k.victim.steamId, 'infected');
		mem.askedAt.set(k.victim.steamId, now);
		const by = mem.infectedBy.get(k.killer.steamId);
		mem.infectedBy.set(k.killer.steamId, {
			name: k.killer.name || k.killer.steamId,
			count: (by?.count ?? 0) + 1
		});
		infected.push({ victim: k.victim, killer: k.killer, eventId: k.eventId });
	}
	return { infected };
}

/** Marks the milestones a round has already passed (or starts at) as told, so they never are. */
function passMilestones(cfg: InfectionConfig, mem: InfectionMemory, survivors: number): void {
	for (const n of cfg.milestones) if (n >= survivors) mem.milestonesTold.add(n);
}

/**
 * What the round has come to, said once each: the survivors down to a milestone (only the lowest
 * reached, when a burst of kills passes several), one survivor left, or none (the round is over).
 * Only players on the list count: a survivor who left is no survivor. Mutates `mem`.
 */
export function roundNews(
	cfg: InfectionConfig,
	mem: InfectionMemory,
	players: InfectionPlayer[]
): InfectionNews[] {
	if (mem.phase !== 'running' || mem.timeUp) return [];
	const on = players.filter((p) => mem.roles.has(p.steamId));
	const infected = on.filter((p) => mem.roles.get(p.steamId) === 'infected');
	const survivors = on.filter((p) => mem.roles.get(p.steamId) === 'survivor');
	if (!infected.length) return [];
	mem.lastCounts = { infected: infected.length, survivors: survivors.length };
	if (!survivors.length) {
		mem.phase = 'over';
		return [{ kind: 'all' }];
	}
	if (survivors.length === 1) {
		passMilestones(cfg, mem, 1);
		if (mem.lastSurvivorTold) return [];
		mem.lastSurvivorTold = true;
		return [{ kind: 'last', survivor: survivors[0] }];
	}
	const reached = cfg.milestones.filter((n) => n >= survivors.length && !mem.milestonesTold.has(n));
	if (!reached.length) return [];
	for (const n of reached) mem.milestonesTold.add(n);
	return [{ kind: 'few', survivors: survivors.length }];
}

/**
 * A timed round's clock: the time left announced as it falls to each warning (only the lowest
 * reached, with the minutes as they are; a warning longer than the limit never), and once it runs
 * out with survivors on, the end. Mutates `mem`.
 */
export function timeNews(cfg: InfectionConfig, mem: InfectionMemory, now: number): InfectionNews[] {
	if (!cfg.timeLimitMinutes || mem.phase !== 'running' || mem.timeUp || !mem.clockFrom) return [];
	const left = mem.clockFrom + cfg.timeLimitMinutes * 60_000 - now;
	if (left <= 0) {
		mem.timeUp = true;
		for (const w of cfg.timeWarnings) mem.timeWarned.add(w);
		return [{ kind: 'timeup' }];
	}
	const reached = cfg.timeWarnings.filter(
		(w) => w < cfg.timeLimitMinutes && left <= w * 60_000 && !mem.timeWarned.has(w)
	);
	if (!reached.length) return [];
	for (const w of reached) mem.timeWarned.add(w);
	return [{ kind: 'time', minutes: Math.ceil(left / 60_000) }];
}

/** How long a timed round has left (ms), or null when it is not timed or not running. */
export const timeLeft = (cfg: InfectionConfig, mem: InfectionMemory, now: number): number | null =>
	cfg.timeLimitMinutes && mem.phase === 'running' && mem.clockFrom && !mem.timeUp
		? Math.max(0, mem.clockFrom + cfg.timeLimitMinutes * 60_000 - now)
		: null;

/**
 * A round taken over after a restart has its clock from the moment it was taken; the kill feed
 * stamps each kill with the game's match clock, so the first kill read puts the start where the
 * match began. Mutates `mem`.
 */
export function syncRoundClock(mem: InfectionMemory, receivedAt: number, eventTimeS: number): void {
	if (!mem.clockGuessed || !Number.isFinite(eventTimeS) || eventTimeS < 0) return;
	mem.clockFrom = receivedAt - eventTimeS * 1000;
	mem.clockGuessed = false;
}

/** How the round stands, for the rule's row and the placeholders. */
export function roundCounts(mem: InfectionMemory, players: InfectionPlayer[]) {
	let infected = 0;
	let survivors = 0;
	for (const p of players) {
		const r = mem.roles.get(p.steamId);
		if (r === 'infected') infected++;
		else if (r === 'survivor') survivors++;
	}
	return { infected, survivors };
}

function roundLine(mem: InfectionMemory, players: InfectionPlayer[]): string {
	const { infected, survivors } = roundCounts(mem, players);
	if (mem.phase === 'over') return `Round over: all ${infected} infected`;
	return `Round on: ${infected} infected, ${survivors} survivor${survivors === 1 ? '' : 's'}`;
}

// ---- worker memory -------------------------------------------------------------------------------

const memories = new Map<string, { serverId: string; mem: InfectionMemory }>();

/** The rule's memory, started over when its settings changed. */
export function infectionMemory(serverId: string, ruleId: string, key: string): InfectionMemory {
	const kept = memories.get(ruleId);
	if (kept?.mem.key === key) return kept.mem;
	const mem = newInfectionMemory(key);
	memories.set(ruleId, { serverId, mem });
	return mem;
}

/** The memory of a rule whose round is known, or undefined (the kill feed acts only on a known round). */
export const knownInfection = (ruleId: string, key: string): InfectionMemory | undefined => {
	const kept = memories.get(ruleId);
	return kept?.mem.key === key ? kept.mem : undefined;
};

/** Forgets one server's rules that are no longer on (deleted or switched off). */
export function keepInfections(serverId: string, live: Set<string>): void {
	for (const [id, k] of memories) if (k.serverId === serverId && !live.has(id)) memories.delete(id);
}

export function forgetInfections(): void {
	memories.clear();
}
