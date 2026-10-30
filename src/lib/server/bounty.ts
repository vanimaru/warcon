// The Bounty rule's own part: who is on a run, who gets a bounty, which kill claims it, and the
// worker's memory of both. A run is the match page's Best streak (feedRecord): a kill of another
// player that is not a team kill or a suicide adds to the killer's run, any death ends the victim's.
// Who is marked is the rule's pick: a run that reaches its count ('streak', one bounty open on the
// server at a time, as the rule always did), each side's top killers of the match ('top'), or the
// players the rule names ('manual'), up to 1 to 3 open on each side at once for those two. A player
// whose bounty is claimed is not marked again by them that match. The first enemy to kill a marked
// player claims it, and a team kill, a suicide or the environment never does, so nobody clears
// their own or has a friend do it. It lapses when the player leaves, the match ends, or the panel
// loses sight of the server (it cannot tell what happened meanwhile). No database
// and no game server here: the live path (feed-events.ts for kills, triggers.ts for leaves and match
// ends) and the dry run (triggers.ts) run the same steps.
import { ApiError, int, str } from './http';
import { settingsFingerprint } from './fingerprint';
import { MAX_CHAT } from '$lib/chat';

/**
 * The outbox action of a claimed bounty's reserved slot: a panel action, the player goes on a
 * reserved list.
 */
export const BOUNTY_REWARD = 'bounty_reward';
/**
 * The outbox actions that note a bounty claimed and a bounty lapsing: panel actions whose audit row is
 * the delivery, so the trail says who claimed it whatever the rule announces.
 */
export const BOUNTY_CLAIM = 'bounty_claim';
export const BOUNTY_LAPSE = 'bounty_lapse';

export type BountyReward = 'slot' | 'none';
/** Who gets a bounty: a run that reaches the count, each side's top killers, or players named. */
export type BountyPick = 'streak' | 'top' | 'manual';
export const BOUNTY_MAX_PER_FACTION = 3;
export const BOUNTY_MAX_WANTED = 30;
/** A player the rule names (pick 'manual'): marked whenever they are on, until claimed that match. */
export interface BountyWanted {
	steamId: string;
	name: string;
}
/** Where a claimed slot goes: this server's own reserved list, or the organisation's. */
export type BountyScope = 'server' | 'org';

export interface BountyConfig {
	/** who gets a bounty (rules saved before it existed have none: 'streak') */
	pick: BountyPick;
	/** kills in a row without dying, in one match, that put a bounty on a player (pick 'streak') */
	streak: number;
	/** bounties open at once on each side (picks 'top' and 'manual'), 1 to 3 */
	perFaction: number;
	/** the kills in the match a side's top killer needs before they are marked (pick 'top') */
	minKills: number;
	/** the players marked whenever they are on (pick 'manual'), in the rule's order */
	wanted: BountyWanted[];
	/** nobody is marked while fewer than this many are on */
	minPlayers: number;
	reward: BountyReward;
	/** how long the claimer's reserved slot lasts */
	slotDays: number;
	scope: BountyScope;
	/** broadcast when a bounty is set */
	setMessage: string;
	/** broadcast when it is claimed; '' for none */
	claimMessage: string;
	/** whispered to the claimer; '' for none */
	whisper: string;
}

export const BOUNTY_SET_MESSAGE =
	'BOUNTY on {name}: {streak} kills without dying. Kill them for {reward}.';
export const BOUNTY_SET_MESSAGE_PLAIN =
	'BOUNTY on {name}: {streak} kills without dying. Who ends the run?';
export const BOUNTY_TOP_MESSAGE =
	'BOUNTY on {name} of {faction}: {streak} kills, the most on their side. Kill them for {reward}.';
export const BOUNTY_TOP_MESSAGE_PLAIN =
	'BOUNTY on {name} of {faction}: {streak} kills, the most on their side. Who takes them down?';
export const BOUNTY_MANUAL_MESSAGE = 'BOUNTY on {name} of {faction}. Kill them for {reward}.';
export const BOUNTY_MANUAL_MESSAGE_PLAIN = 'BOUNTY on {name} of {faction}. Who takes them down?';

/** The announcement a rule without its own gets, by pick and reward. */
export const bountySetDefault = (pick: BountyPick, reward: BountyReward): string =>
	pick === 'top'
		? reward === 'slot'
			? BOUNTY_TOP_MESSAGE
			: BOUNTY_TOP_MESSAGE_PLAIN
		: pick === 'manual'
			? reward === 'slot'
				? BOUNTY_MANUAL_MESSAGE
				: BOUNTY_MANUAL_MESSAGE_PLAIN
			: reward === 'slot'
				? BOUNTY_SET_MESSAGE
				: BOUNTY_SET_MESSAGE_PLAIN;

/** A rule's pick, 'streak' for one saved before picks existed. */
export const bountyPick = (c: unknown): BountyPick => {
	const v = c && typeof c === 'object' ? (c as Record<string, unknown>).pick : undefined;
	return v === 'top' || v === 'manual' ? v : 'streak';
};

const STEAM_ID = /^\d{17}$/;

/** What a rule's reward needs of whoever saves it: a slot here, or on the organisation's list. */
export const bountyScope = (c: unknown): BountyScope =>
	c && typeof c === 'object' && (c as Record<string, unknown>).scope === 'org' ? 'org' : 'server';
export const bountyReward = (c: unknown): BountyReward =>
	c && typeof c === 'object' && (c as Record<string, unknown>).reward === 'none' ? 'none' : 'slot';

export function validateBounty(c: Record<string, unknown>): BountyConfig {
	const reward = bountyReward(c);
	const pick = bountyPick(c);
	const wanted: BountyWanted[] = [];
	for (const w of Array.isArray(c.wanted) ? c.wanted : []) {
		const o = (w && typeof w === 'object' ? w : {}) as Record<string, unknown>;
		const steamId = str(o.steamId, 17);
		if (!STEAM_ID.test(steamId))
			throw new ApiError(400, `Not a SteamID64 (17 digits): ${steamId || '(blank)'}.`);
		if (wanted.some((x) => x.steamId === steamId)) continue;
		wanted.push({ steamId, name: str(o.name, 64) || steamId });
	}
	if (wanted.length > BOUNTY_MAX_WANTED)
		throw new ApiError(400, `At most ${BOUNTY_MAX_WANTED} players to put a bounty on.`);
	if (pick === 'manual' && !wanted.length)
		throw new ApiError(400, 'Name at least one player to put a bounty on.');
	return {
		pick,
		streak: int(c.streak, 15, 3, 200),
		perFaction: int(c.perFaction, 1, 1, BOUNTY_MAX_PER_FACTION),
		minKills: int(c.minKills, 5, 1, 200),
		wanted,
		minPlayers: int(c.minPlayers, 20, 0, 1000),
		reward,
		slotDays: int(c.slotDays, 1, 1, 365),
		scope: bountyScope(c),
		setMessage: str(c.setMessage, MAX_CHAT) || bountySetDefault(pick, reward),
		claimMessage: str(c.claimMessage, MAX_CHAT),
		whisper: str(c.whisper, MAX_CHAT)
	};
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** The reward in words, for `{reward}` and the panel's own lines; '' for none. */
export const rewardWords = (cfg: Pick<BountyConfig, 'reward' | 'slotDays'>): string =>
	cfg.reward === 'slot' ? `a reserved slot for ${days(cfg.slotDays)}` : '';

/** One player of a kill as the rule reads them. */
export interface BountyPlayer {
	steamId: string;
	name: string;
	faction: string | null;
}

/** One kill as the rule reads it. */
export interface BountyKill {
	eventId: string;
	killer: BountyPlayer | null;
	victim: BountyPlayer;
	suicide: boolean;
	teamKill: boolean;
}

/** The bounty open on a server. */
export interface OpenBounty extends BountyPlayer {
	/** the run that put the bounty on them */
	streak: number;
	/** their longest run since it was set, for the claim (in memory; written with the next change) */
	best: number;
	/** when it was set (ms) */
	setAt: number;
	/**
	 * the match it was set in (matchKey of the batch), so one read back after a restart is not
	 * claimed in a later match; '' until known
	 */
	match: string;
	/** how they were picked; `streak` is then their run, or their kills in the match */
	how: BountyPick;
}

/** A rule's runs, its open bounties, and who has had one claimed this match. */
export interface BountyTrack {
	runs: Map<string, number>;
	open: OpenBounty[];
	/** players whose bounty was claimed this match: the top and named picks pass them over */
	claimed: Set<string>;
}

export const newBountyTrack = (): BountyTrack => ({
	runs: new Map(),
	open: [],
	claimed: new Set()
});

export type BountyEvent =
	| { kind: 'set'; bounty: OpenBounty; kill: BountyKill }
	| { kind: 'claim'; bounty: OpenBounty; claimer: BountyPlayer; kill: BountyKill };

/** A kill that adds to the killer's run: of another player, not a team kill or a suicide. */
const scores = (k: BountyKill): boolean =>
	!!k.killer && !k.suicide && !k.teamKill && k.killer.steamId !== k.victim.steamId;

/**
 * A kill that claims the bounty on its victim: one that scores, by a player whose side is known and
 * not the victim's. A kill between players whose sides the panel has not seen could be a friend's.
 */
export const claims = (k: BountyKill, open: Pick<OpenBounty, 'steamId'>): boolean =>
	k.victim.steamId === open.steamId &&
	scores(k) &&
	!!k.killer!.faction &&
	!!k.victim.faction &&
	k.killer!.faction !== k.victim.faction;

/**
 * Takes in kills in the order the game played them: a claim first (a marked player's death), then
 * the victim's run ends and the killer's grows, and, with pick 'streak', a run that reaches the
 * rule's count while no bounty is open, with `canMark` (enough players on), puts one on the killer.
 * The claimer can be marked by the very kill that claims. The other picks mark at a look
 * (bountyPicks); kills only claim theirs. Moves `track` on and returns what happened.
 */
export function bountyStep(
	cfg: Pick<BountyConfig, 'streak'> & Partial<Pick<BountyConfig, 'pick'>>,
	track: BountyTrack,
	inOrder: BountyKill[],
	at: { canMark: boolean; now: number }
): BountyEvent[] {
	const out: BountyEvent[] = [];
	const streak = bountyPick(cfg) === 'streak';
	for (const k of inOrder) {
		const i = track.open.findIndex((o) => claims(k, o));
		if (i >= 0) {
			const [b] = track.open.splice(i, 1);
			track.claimed.add(b.steamId);
			out.push({ kind: 'claim', bounty: b, claimer: k.killer!, kill: k });
		}
		track.runs.delete(k.victim.steamId);
		if (!scores(k)) continue;
		const killer = k.killer!;
		const run = (track.runs.get(killer.steamId) ?? 0) + 1;
		track.runs.set(killer.steamId, run);
		const mine = track.open.find((o) => o.steamId === killer.steamId);
		if (mine) mine.best = Math.max(mine.best, run);
		else if (streak && !track.open.length && at.canMark && run >= cfg.streak) {
			const b: OpenBounty = {
				steamId: killer.steamId,
				name: killer.name || killer.steamId,
				faction: killer.faction,
				streak: run,
				best: run,
				setAt: at.now,
				match: '',
				how: 'streak'
			};
			track.open.push(b);
			out.push({ kind: 'set', bounty: b, kill: k });
		}
	}
	return out;
}

/** A player on the server as the top and named picks read them: their side and kills this match. */
export interface PickPlayer extends BountyPlayer {
	kills: number;
}

/**
 * The bounties a look puts on players, with pick 'top' or 'manual': on each side, while fewer than
 * `perFaction` are open there, the side's top killers with at least `minKills` this match, or the
 * rule's named players in its order, among those on now. Nobody marked already, nobody whose bounty
 * was claimed this match, nobody whose side is unknown, and nobody while too few are on. A side is
 * the one the player is on now. Moves `track` on and returns the bounties set.
 */
export function bountyPicks(
	cfg: Partial<Pick<BountyConfig, 'pick' | 'perFaction' | 'minKills' | 'wanted'>>,
	track: BountyTrack,
	players: PickPlayer[],
	at: { canMark: boolean; now: number }
): OpenBounty[] {
	const pick = bountyPick(cfg);
	if (pick === 'streak' || !at.canMark) return [];
	const per = Math.min(BOUNTY_MAX_PER_FACTION, Math.max(1, cfg.perFaction ?? 1));
	const sideOf = new Map(players.map((p) => [p.steamId, p.faction]));
	const onSide = new Map<string, number>();
	for (const o of track.open) {
		const f = sideOf.get(o.steamId) ?? o.faction;
		if (f) onSide.set(f, (onSide.get(f) ?? 0) + 1);
	}
	const candidates =
		pick === 'top'
			? players
					.filter((p) => p.kills >= Math.max(1, cfg.minKills ?? 5))
					.sort((a, b) => b.kills - a.kills || a.steamId.localeCompare(b.steamId))
			: (cfg.wanted ?? []).flatMap((w) => players.filter((p) => p.steamId === w.steamId));
	const out: OpenBounty[] = [];
	for (const p of candidates) {
		const f = p.faction;
		if (!f || track.claimed.has(p.steamId) || track.open.some((o) => o.steamId === p.steamId))
			continue;
		if ((onSide.get(f) ?? 0) >= per) continue;
		onSide.set(f, (onSide.get(f) ?? 0) + 1);
		const b: OpenBounty = {
			steamId: p.steamId,
			name: p.name || p.steamId,
			faction: f,
			streak: p.kills,
			best: track.runs.get(p.steamId) ?? 0,
			setAt: at.now,
			match: '',
			how: pick
		};
		track.open.push(b);
		out.push(b);
	}
	return out;
}

/**
 * Why an open bounty lapses: its player left, the match ended, or the panel lost sight of the server
 * (out of reach for a few looks, its own restart among them), after which it cannot tell either.
 */
export type BountyLapse = 'left' | 'match' | 'lost';

/** What a bounty stood on, in words: the run, the kills that made them a side's top, or the name. */
export const runWords = (
	b: Pick<OpenBounty, 'best'> & Partial<Pick<OpenBounty, 'how' | 'streak'>>
) =>
	b.how === 'top'
		? `${b.streak ?? 0} kills when marked`
		: b.how === 'manual'
			? 'named by the rule'
			: `a run of ${b.best}`;

/** What the panel says of a lapse. */
export const lapseWords = (
	b: Pick<OpenBounty, 'name' | 'best'> & Partial<Pick<OpenBounty, 'how' | 'streak'>>,
	why: BountyLapse
): string =>
	`The bounty on ${b.name} lapsed: ${
		why === 'left'
			? 'they left the server'
			: why === 'match'
				? 'the match ended'
				: 'the server was out of reach'
	} (${runWords(b)}).`;

/**
 * Whether a bounty set in match `set` is from before the match `now` (both matchKey): only two
 * matches the panel opened are told apart, so a bounty set or claimed while none was open stands.
 */
export const fromEarlierMatch = (set: string, now: string): boolean =>
	set.startsWith('m') && now.startsWith('m') && set !== now;

// ---- the worker's memory ------------------------------------------------------------------------

/**
 * What a rule's open bounty and runs were kept under: its settings and its last save. Any save of the
 * rule (switching it off and on included) calls off an open bounty and starts the runs over; the
 * saved state of an older save is not read back.
 */
export const bountyVersion = (row: { config: unknown; updatedAt: Date | null }): string =>
	`${settingsFingerprint(row.config)}:${row.updatedAt?.getTime() ?? 0}`;

/**
 * The rule's state as written to its row, under the version it was set in: the open bounties and who
 * has had one claimed this match. A row written before there could be several holds `open` alone.
 */
export interface BountyState {
	version: string;
	bounties: OpenBounty[];
	claimed: string[];
	/** the one open bounty of a row written before there could be several */
	open?: OpenBounty | null;
}

const savedOne = (o: unknown): OpenBounty | null => {
	if (!o || typeof o !== 'object') return null;
	const b = o as Record<string, unknown>;
	return typeof b.steamId === 'string' && typeof b.name === 'string'
		? {
				steamId: b.steamId,
				name: b.name,
				faction: typeof b.faction === 'string' ? b.faction : null,
				streak: Number(b.streak) || 0,
				best: Number(b.best) || Number(b.streak) || 0,
				setAt: Number(b.setAt) || 0,
				match: typeof b.match === 'string' ? b.match : '',
				how: bountyPick({ pick: b.how })
			}
		: null;
};

/** The open bounties and the claimed a row's saved state holds for this version. */
export function savedBounties(
	state: unknown,
	version: string
): { open: OpenBounty[]; claimed: string[] } {
	const s = state as Partial<BountyState> | null;
	if (!s || typeof s !== 'object' || s.version !== version) return { open: [], claimed: [] };
	const list = Array.isArray(s.bounties) ? s.bounties : s.open ? [s.open] : [];
	return {
		open: list.map(savedOne).filter((b): b is OpenBounty => !!b),
		claimed: Array.isArray(s.claimed) ? s.claimed.filter((x) => typeof x === 'string') : []
	};
}

export const bountyState = (
	version: string,
	open: OpenBounty[],
	claimed: Iterable<string> = []
): BountyState => ({
	version,
	bounties: open.map((b) => ({ ...b })),
	claimed: [...claimed]
});

/**
 * Each Bounty rule's runs and open bounty in this process's memory, by server and rule. The open
 * bounty is also written to the rule's row as it changes, so a restart keeps the hunt and forgets
 * only the runs. Kept only for servers with the rule on.
 */
const memory = new Map<string, Map<string, { version: string; track: BountyTrack }>>();

/** The rule's track, read back from its row's state the first time this process sees it. */
export function bountyTrack(row: {
	id: string;
	serverId: string;
	config: unknown;
	state: unknown;
	updatedAt: Date | null;
}): { version: string; track: BountyTrack } {
	const version = bountyVersion(row);
	let mine = memory.get(row.serverId);
	if (!mine) memory.set(row.serverId, (mine = new Map()));
	let m = mine.get(row.id);
	if (!m || m.version !== version) {
		const saved = savedBounties(row.state, version);
		m = {
			version,
			track: { runs: new Map(), open: saved.open, claimed: new Set(saved.claimed) }
		};
		mine.set(row.id, m);
	}
	return m;
}

/** Drops the tracks of a server's rules that are no longer on. */
export function keepBounties(serverId: string, live: ReadonlySet<string>): void {
	const mine = memory.get(serverId);
	if (!mine) return;
	for (const id of mine.keys()) if (!live.has(id)) mine.delete(id);
	if (!mine.size) memory.delete(serverId);
}

/** Forgets the tracks of one server (removed from the worker), or of every server. */
export function forgetBounties(serverId?: string): void {
	if (serverId) memory.delete(serverId);
	else memory.clear();
}

// ---- the dry run ----------------------------------------------------------------------------------

/** One thing the replay takes in, in the order it happened. */
export type BountyReplayEvent =
	| {
			kind: 'kills';
			at: number;
			/** the match the batch was stamped with (matchKey) */
			match: string;
			/** players on when the batch came in */
			players: number;
			kills: BountyKill[];
	  }
	| { kind: 'left'; at: number; steamId: string };

export type BountyOutcome =
	| { kind: 'set'; at: number; bounty: OpenBounty; players: number }
	| { kind: 'claim'; at: number; bounty: OpenBounty; claimer: BountyPlayer }
	| { kind: 'lapse'; at: number; bounty: OpenBounty; why: BountyLapse };

/**
 * The live rule over a stretch of history: batches through bountyStep, and with the top or named
 * pick bountyPicks after each batch, over the players seen in the match so far (their sides and
 * kills as the feed told them, a player gone once their session closes). Runs, the claimed and the
 * players seen start over and the open bounties lapse at each new match; one lapses when its
 * player's session closes.
 */
export function bountyReplay(
	cfg: Pick<BountyConfig, 'streak' | 'minPlayers'> &
		Partial<Pick<BountyConfig, 'pick' | 'perFaction' | 'minKills' | 'wanted'>>,
	events: BountyReplayEvent[]
): { outcomes: BountyOutcome[]; open: OpenBounty[] } {
	const track = newBountyTrack();
	const outcomes: BountyOutcome[] = [];
	const seen = new Map<string, PickPlayer>();
	const picks = bountyPick(cfg) !== 'streak';
	let match: string | null = null;
	const lapse = (at: number, why: BountyLapse, which: (b: OpenBounty) => boolean) => {
		for (const b of track.open.filter(which)) outcomes.push({ kind: 'lapse', at, bounty: b, why });
		track.open = track.open.filter((b) => !which(b));
	};
	for (const e of events) {
		if (e.kind === 'left') {
			seen.delete(e.steamId);
			lapse(e.at, 'left', (b) => b.steamId === e.steamId);
			continue;
		}
		if (match !== null && e.match !== match) {
			lapse(e.at, 'match', () => true);
			track.runs.clear();
			track.claimed.clear();
			seen.clear();
		}
		match = e.match;
		const canMark = e.players >= cfg.minPlayers;
		for (const x of bountyStep(cfg, track, e.kills, { canMark, now: e.at }))
			outcomes.push(
				x.kind === 'set'
					? { kind: 'set', at: e.at, bounty: { ...x.bounty }, players: e.players }
					: { kind: 'claim', at: e.at, bounty: { ...x.bounty }, claimer: x.claimer }
			);
		if (!picks) continue;
		for (const k of e.kills) {
			for (const who of [k.killer, k.victim]) {
				if (!who) continue;
				const was = seen.get(who.steamId);
				seen.set(who.steamId, {
					...who,
					faction: who.faction ?? was?.faction ?? null,
					kills: was?.kills ?? 0
				});
			}
			if (k.killer && !k.suicide && !k.teamKill && k.killer.steamId !== k.victim.steamId)
				seen.get(k.killer.steamId)!.kills++;
		}
		for (const b of bountyPicks(cfg, track, [...seen.values()], { canMark, now: e.at }))
			outcomes.push({ kind: 'set', at: e.at, bounty: { ...b }, players: e.players });
	}
	return { outcomes, open: track.open };
}
