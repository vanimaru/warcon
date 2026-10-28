// The Infection rule (kind `infection`): a game mode built from the kill feed and the move without the
// kill. Each round starts with a few players on the infected side and everyone else on the survivors'
// side. A survivor killed by an infected player joins the infected (moved as they lie dead, so they
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
export const INFECTION_MAX_PATIENTS = 10;

export interface InfectionConfig {
	/** the faction the infected play on */
	infectedFaction: string;
	/** the faction the survivors play on; players on any other side are moved here at the start */
	survivorFaction: string;
	/** how many players start each round infected (picked at random) */
	startInfected: number;
	/** a round starts only with at least this many on */
	minPlayers: number;
	/** broadcast when a round starts; `{patients}` names the first infected */
	startMessage: string;
	/** whispered to a survivor as they are infected; `{killer}` infected them */
	infectWhisper: string;
	/** broadcast at every infection; `{name}` the newly infected, `{killer}` who infected them */
	infectBroadcast: string;
	/** broadcast once a round when one survivor is left; `{name}` is them */
	lastSurvivorMessage: string;
	/** broadcast when nobody is left uninfected */
	allInfectedMessage: string;
	/** end the match once everyone is infected, so the next round starts on the next map */
	endMatch: boolean;
}

const FACTION = /^[A-Za-z0-9 _.'-]{1,40}$/;

export function validateInfection(c: Record<string, unknown>): InfectionConfig {
	const infectedFaction = str(c.infectedFaction, 41);
	const survivorFaction = str(c.survivorFaction, 41);
	for (const [what, f] of [
		['infected', infectedFaction],
		['survivors’', survivorFaction]
	])
		if (!FACTION.test(f))
			throw new ApiError(400, `Pick the ${what} faction, as the game names it (Manticore, say).`);
	if (same(infectedFaction, survivorFaction))
		throw new ApiError(400, 'The infected and the survivors need two different factions.');
	const text = (k: keyof typeof INFECTION_DEFAULTS) =>
		c[k] === undefined ? INFECTION_DEFAULTS[k] : str(c[k], 256);
	return {
		infectedFaction,
		survivorFaction,
		startInfected: int(c.startInfected, 1, 1, INFECTION_MAX_PATIENTS),
		minPlayers: int(c.minPlayers, 6, 2, 1000),
		startMessage: text('startMessage'),
		infectWhisper: text('infectWhisper'),
		infectBroadcast: text('infectBroadcast'),
		lastSurvivorMessage: text('lastSurvivorMessage'),
		allInfectedMessage: text('allInfectedMessage'),
		endMatch: c.endMatch === true
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
	lastSurvivorTold: false
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
	| { kind: 'last'; survivor: InfectionPlayer }
	| { kind: 'all' };

export interface InfectionLook {
	moves: InfectionMove[];
	news: InfectionNews[];
	/** what the rule's row says, when it has something new to say */
	result: string | null;
}

const nextRound = (mem: InfectionMemory, now: number) => Math.max(now, mem.round + 1);

const desired = (cfg: InfectionConfig, role: InfectionRole) =>
	role === 'infected' ? cfg.infectedFaction : cfg.survivorFaction;

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
		now: number;
		perLook?: number;
		rand?: () => number;
	}
): InfectionLook {
	const { players, factions, now } = input;
	const out: InfectionLook = { moves: [], news: [], result: null };
	if (input.matchEnded) {
		mem.phase = 'waiting';
		mem.roles.clear();
		mem.askedAt.clear();
		mem.placed.clear();
		mem.waitingSince = 0;
		mem.lastSurvivorTold = false;
	}
	const missing = [cfg.infectedFaction, cfg.survivorFaction].filter(
		(f) => !factions.some((x) => same(x, f))
	);
	if (missing.length) {
		out.result = `Waiting: this match has no ${missing.join(' or ')} faction`;
		return out;
	}
	const picked = players.filter((p) => p.faction);
	const enough = players.length >= cfg.minPlayers;

	if (mem.phase === 'adopt') {
		if (!enough || !picked.length) {
			out.result = `Waiting for ${cfg.minPlayers} players`;
			return out;
		}
		// What the server shows is the round: everyone on the infected side is infected.
		for (const p of picked)
			mem.roles.set(p.steamId, same(p.faction, cfg.infectedFaction) ? 'infected' : 'survivor');
		mem.startedAt = 0;
		mem.round = nextRound(mem, now);
		mem.phase = [...mem.roles.values()].includes('infected') ? 'running' : 'waiting';
		if (mem.phase === 'running') out.result = roundLine(mem, players);
	}

	if (mem.phase === 'waiting') {
		if (!enough || picked.length < 2) {
			mem.waitingSince = 0;
			out.result = `Waiting for ${cfg.minPlayers} players`;
			return out;
		}
		if (!mem.waitingSince) mem.waitingSince = now;
		const ready =
			picked.length >= players.length * INFECTION_PICKED_SHARE ||
			now - mem.waitingSince >= INFECTION_SETUP_WAIT_MS;
		if (!ready) return out;
		const patients = pickRandom(picked, Math.min(cfg.startInfected, picked.length - 1), input.rand);
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
		out.news.push({ kind: 'start', patients });
		out.result = `Round started: ${patients.map((p) => p.name || p.steamId).join(', ')} infected`;
	}

	// running or over: keep everyone on their side
	const perLook = Math.max(1, input.perLook ?? INFECTION_MAX_MOVES_PER_LOOK);
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
		const to = desired(cfg, role);
		if (same(p.faction, to)) {
			mem.askedAt.delete(p.steamId);
			mem.placed.add(p.steamId);
			continue;
		}
		const asked = mem.askedAt.get(p.steamId);
		if (asked !== undefined && now - asked < INFECTION_REASK_MS) continue;
		if (out.moves.length >= perLook) continue;
		mem.askedAt.set(p.steamId, now);
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
	out.news.push(...roundNews(mem, players));
	if (!out.result && out.news.length) out.result = roundLine(mem, players);
	return out;
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
	if (mem.phase !== 'running') return { infected };
	for (const k of kills) {
		if (!k.killer || k.suicide || k.killer.steamId === k.victim.steamId) continue;
		if (mem.roles.get(k.killer.steamId) !== 'infected') continue;
		if (mem.roles.get(k.victim.steamId) !== 'survivor') continue;
		mem.roles.set(k.victim.steamId, 'infected');
		mem.askedAt.set(k.victim.steamId, now);
		infected.push({ victim: k.victim, killer: k.killer, eventId: k.eventId });
	}
	return { infected };
}

/**
 * What the round has come to, said once each: one survivor left, or none (the round is over).
 * Only players on the list count: a survivor who left is no survivor. Mutates `mem`.
 */
export function roundNews(mem: InfectionMemory, players: InfectionPlayer[]): InfectionNews[] {
	if (mem.phase !== 'running') return [];
	const on = players.filter((p) => mem.roles.has(p.steamId));
	const infected = on.filter((p) => mem.roles.get(p.steamId) === 'infected');
	const survivors = on.filter((p) => mem.roles.get(p.steamId) === 'survivor');
	if (!infected.length) return [];
	if (!survivors.length) {
		mem.phase = 'over';
		return [{ kind: 'all' }];
	}
	if (survivors.length === 1 && !mem.lastSurvivorTold) {
		mem.lastSurvivorTold = true;
		return [{ kind: 'last', survivor: survivors[0] }];
	}
	return [];
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
