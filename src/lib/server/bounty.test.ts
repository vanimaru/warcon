import { describe, expect, test } from 'bun:test';
import {
	BOUNTY_MARKED_WHISPER,
	bountyPicks,
	bountyReplay,
	bountyState,
	bountyStep,
	bountyTrack,
	bountyVersion,
	claims,
	forgetBounties,
	fromEarlierMatch,
	keepBounties,
	lapseWords,
	newBountyTrack,
	newMatch,
	rewardWords,
	runWords,
	savedBounties,
	trackState,
	validateBounty,
	type BountyKill,
	type BountyPlayer,
	type BountyTrack,
	type PickPlayer
} from './bounty';

const RED = 'Valkyra';
const BLUE = 'Lonestar';
const p = (n: number, faction: string | null = RED): BountyPlayer => ({
	steamId: `7656119800000${String(n).padStart(4, '0')}`,
	name: `Player ${n}`,
	faction
});
const A = p(1, RED);
const B = p(2, BLUE);
const C = p(3, BLUE);
const D = p(4, RED);
let seq = 0;
const kill = (
	killer: BountyPlayer | null,
	victim: BountyPlayer,
	o: { suicide?: boolean; teamKill?: boolean } = {}
): BountyKill => ({
	eventId: `e${++seq}`,
	killer,
	victim,
	suicide: !!o.suicide,
	teamKill: !!o.teamKill
});
const fresh = (): BountyTrack => newBountyTrack();
const step = (track: BountyTrack, kills: BountyKill[], canMark = true, streak = 3) =>
	bountyStep({ streak }, track, kills, { canMark, now: 1000 });

describe('the Bounty rule, settings', () => {
	test('defaults, clamps and the announcement a blank one gets', () => {
		const d = validateBounty({});
		expect(d).toEqual({
			pick: 'streak',
			streak: 15,
			perFaction: 1,
			minKills: 5,
			wanted: [],
			minPlayers: 20,
			reward: 'slot',
			winClaims: 5,
			winMessage: '{winner} wins the bounty hunt with {claims} bounties claimed!',
			slotDays: 1,
			scope: 'server',
			setMessage: 'BOUNTY on {name}: {streak} kills without dying. Kill them for {reward}.',
			claimMessage: '',
			whisper: '',
			markedWhisper: ''
		});
		const c = validateBounty({
			streak: 1,
			minPlayers: -5,
			reward: 'none',
			slotDays: 9999,
			scope: 'org',
			setMessage: ' ',
			claimMessage: 'x'.repeat(400)
		});
		expect([c.streak, c.minPlayers, c.reward, c.slotDays, c.scope]).toEqual([
			3,
			0,
			'none',
			365,
			'org'
		]);
		expect(c.setMessage).toBe('BOUNTY on {name}: {streak} kills without dying. Who ends the run?');
		expect(c.claimMessage).toHaveLength(256);
		// anything but 'none' is a slot, anything but 'org' this server's list
		expect(validateBounty({ reward: 'role', scope: 'all' })).toMatchObject({
			reward: 'slot',
			scope: 'server'
		});
	});

	test('the reward in words', () => {
		expect(rewardWords({ reward: 'slot', slotDays: 1 })).toBe('a reserved slot for 1 day');
		expect(rewardWords({ reward: 'slot', slotDays: 3 })).toBe('a reserved slot for 3 days');
		expect(rewardWords({ reward: 'none', slotDays: 3 })).toBe('');
	});
});

describe('the Bounty rule, runs and bounties', () => {
	test('a run of kills without dying puts a bounty on the player at the count', () => {
		const t = fresh();
		expect(step(t, [kill(A, B), kill(A, C)])).toEqual([]);
		expect(t.runs.get(A.steamId)).toBe(2);
		const [set] = step(t, [kill(A, B)]);
		expect(set).toMatchObject({ kind: 'set', bounty: { steamId: A.steamId, streak: 3, best: 3 } });
		expect(t.open[0]?.steamId).toBe(A.steamId);
		// more kills while marked grow the run the claim will name
		step(t, [kill(A, C), kill(A, B)]);
		expect(t.open[0]).toMatchObject({ streak: 3, best: 5 });
	});

	test('any death ends a run; a team kill or a suicide adds nothing to one', () => {
		const t = fresh();
		step(t, [kill(A, B), kill(A, C)]);
		step(t, [kill(A, D, { teamKill: true })]);
		expect(t.runs.get(A.steamId)).toBe(2);
		step(t, [kill(null, A)]);
		expect(t.runs.has(A.steamId)).toBe(false);
		step(t, [kill(A, B), kill(A, C), kill(D, A, { teamKill: true })]);
		expect(t.runs.has(A.steamId)).toBe(false);
		step(t, [kill(A, B), kill(A, A, { suicide: true })]);
		expect(t.runs.has(A.steamId)).toBe(false);
		expect(t.open).toEqual([]);
	});

	test('nobody is marked while too few are on; the run counts all the same', () => {
		const t = fresh();
		expect(step(t, [kill(A, B), kill(A, C), kill(A, B)], false)).toEqual([]);
		expect(t.open).toEqual([]);
		// enough on now: marked at their next kill
		expect(step(t, [kill(A, C)])[0]).toMatchObject({ kind: 'set', bounty: { streak: 4 } });
	});

	test('one bounty at a time: the next player on a run is marked at their next kill', () => {
		const t = fresh();
		step(t, [kill(A, B), kill(A, C), kill(A, B)]);
		expect(step(t, [kill(B, D), kill(B, D), kill(B, D)])).toEqual([]);
		expect(t.open[0]?.steamId).toBe(A.steamId);
		// C claims A's; B, on a run of 3 already, is marked at their next kill
		const ended = step(t, [kill(C, A)]);
		expect(ended.map((e) => e.kind)).toEqual(['claim']);
		expect(step(t, [kill(B, D)])[0]).toMatchObject({
			kind: 'set',
			bounty: { steamId: B.steamId, streak: 4 }
		});
	});

	test('only an enemy whose side is known claims it: not a teammate, a suicide or the environment', () => {
		const t = fresh();
		step(t, [kill(A, B), kill(A, C), kill(A, B)]);
		const open = t.open[0];
		expect(step(t, [kill(D, A, { teamKill: true })])).toEqual([]);
		expect(step(t, [kill(A, A, { suicide: true })])).toEqual([]);
		expect(step(t, [kill(null, A)])).toEqual([]);
		// a kill between players whose sides the panel has not seen is no claim
		expect(step(t, [kill(p(9, null), A)])).toEqual([]);
		expect(step(t, [kill(B, { ...A, faction: null })])).toEqual([]);
		// a player the panel takes for an enemy (no team kill) but on the same side is no claim either
		expect(claims(kill(D, A), open)).toBe(false);
		expect(t.open[0]).toBe(open);
		const [claim] = step(t, [kill(B, A)]);
		expect(claim).toMatchObject({ kind: 'claim', claimer: B, bounty: { steamId: A.steamId } });
		expect(t.open).toEqual([]);
	});

	test('the kill that claims it can put the next bounty on the claimer', () => {
		const t = fresh();
		step(t, [kill(A, B), kill(A, C), kill(A, B), kill(B, D), kill(B, D)]);
		const out = step(t, [kill(B, A)]);
		expect(out.map((e) => e.kind)).toEqual(['claim', 'set']);
		expect(t.open[0]).toMatchObject({ steamId: B.steamId, streak: 3 });
	});
});

describe('the Bounty rule, lapses', () => {
	test('what the panel says of each', () => {
		const b = { name: 'Player 1', best: 17 };
		expect(lapseWords(b, 'left')).toBe(
			'The bounty on Player 1 lapsed: they left the server (a run of 17).'
		);
		expect(lapseWords(b, 'match')).toBe(
			'The bounty on Player 1 lapsed: the match ended (a run of 17).'
		);
		expect(lapseWords(b, 'lost')).toBe(
			'The bounty on Player 1 lapsed: the server was out of reach (a run of 17).'
		);
	});

	test('a bounty is from an earlier match only when both are matches the panel opened', () => {
		expect(fromEarlierMatch('m12', 'm13')).toBe(true);
		expect(fromEarlierMatch('m12', 'm12')).toBe(false);
		// set or claimed while no match was open (a server's first seconds): it stands
		expect(fromEarlierMatch('h480000', 'm13')).toBe(false);
		expect(fromEarlierMatch('m12', 'h480001')).toBe(false);
		expect(fromEarlierMatch('', 'm13')).toBe(false);
	});
});

describe('the Bounty rule, its memory', () => {
	test('an open bounty is read back only under the save it was set in', () => {
		const row = { config: { streak: 15 }, updatedAt: new Date(5000) };
		const version = bountyVersion(row);
		const open = { ...A, streak: 15, best: 17, setAt: 4000, match: 'm12', how: 'streak' as const };
		const state = bountyState(version, [open], [B.steamId]);
		expect(savedBounties(state, version)).toEqual({
			open: [open],
			claimed: [B.steamId],
			wins: new Map(),
			decided: false
		});
		const none = { open: [], claimed: [], wins: new Map(), decided: false };
		expect(savedBounties(state, bountyVersion({ ...row, updatedAt: new Date(6000) }))).toEqual(
			none
		);
		expect(savedBounties(state, bountyVersion({ ...row, config: { streak: 20 } }))).toEqual(none);
		expect(savedBounties(bountyState(version, []), version)).toEqual(none);
		expect(savedBounties(null, version)).toEqual(none);
		expect(savedBounties({ version, bounties: [{ steamId: 7 }] }, version)).toEqual(none);
		// a row written when one bounty was open at a time
		const { how: _how, ...old } = open;
		expect(savedBounties({ version, open: old }, version).open).toEqual([open]);
	});

	test("a rule's track comes back from its row once, and starts over after a save", () => {
		forgetBounties();
		const row = {
			id: 'rule-1',
			serverId: 'server-1',
			config: { streak: 3 },
			updatedAt: new Date(1000),
			state: null as unknown
		};
		const open = { ...A, streak: 3, best: 3, setAt: 900, match: 'm3', how: 'streak' as const };
		row.state = bountyState(bountyVersion(row), [open]);
		const first = bountyTrack(row).track;
		expect(first.open).toEqual([open]);
		first.runs.set(B.steamId, 2);
		// the same rule: the memory, not the row
		row.state = null;
		expect(bountyTrack(row).track).toBe(first);
		// saved again: started over, the old state not read back
		row.updatedAt = new Date(2000);
		row.state = bountyState(bountyVersion({ ...row, updatedAt: new Date(1000) }), [open]);
		const after = bountyTrack(row).track;
		expect(after).not.toBe(first);
		expect(after.open).toEqual([]);
		expect(after.runs.size).toBe(0);
		// a rule no longer on is dropped
		keepBounties('server-1', new Set());
		row.state = bountyState(bountyVersion(row), [open]);
		expect(bountyTrack(row).track.open).toEqual([open]);
		forgetBounties('server-1');
	});
});

describe('the Bounty rule, replayed', () => {
	test('runs start over and an open bounty lapses at a new match; a leave lapses it too', () => {
		const batch = (at: number, match: string, kills: BountyKill[], players = 50) => ({
			kind: 'kills' as const,
			at,
			match,
			players,
			kills
		});
		const { outcomes, open } = bountyReplay({ streak: 3, minPlayers: 20 }, [
			batch(1, 'm1', [kill(A, B), kill(A, C)]),
			// a new match: A's run of 2 starts over
			batch(2, 'm2', [kill(A, B), kill(A, C)]),
			batch(3, 'm2', [kill(A, B)], 10),
			batch(4, 'm2', [kill(A, C)]),
			batch(5, 'm3', [kill(B, C)]),
			batch(6, 'm3', [kill(B, C), kill(B, D), kill(B, D)]),
			{ kind: 'left', at: 7, steamId: B.steamId },
			batch(8, 'm3', [kill(C, D), kill(C, D), kill(C, D), kill(C, D)]),
			batch(9, 'm3', [kill(A, C)])
		]);
		expect(
			outcomes.map((o) => [
				o.kind,
				o.at,
				'bounty' in o ? o.bounty.steamId : '',
				'why' in o ? o.why : ''
			])
		).toEqual([
			// too few on at 3; marked at the next kill
			['set', 4, A.steamId, ''],
			['lapse', 5, A.steamId, 'match'],
			['set', 6, B.steamId, ''],
			['lapse', 7, B.steamId, 'left'],
			['set', 8, C.steamId, ''],
			['claim', 9, C.steamId, '']
		]);
		expect(outcomes[0]).toMatchObject({ bounty: { streak: 4 }, players: 50 });
		expect(open).toEqual([]);
	});
});

describe('the Bounty rule, picked by side', () => {
	const on = (pl: BountyPlayer, kills: number): PickPlayer => ({ ...pl, kills });
	const E = p(5, RED);
	const F = p(6, BLUE);
	const G = p(7, RED);
	const at = { canMark: true, now: 2000 };

	test('the pick and the count on each side are settings; named players need SteamIDs', () => {
		const top = validateBounty({ pick: 'top', perFaction: 9, minKills: 0 });
		expect([top.pick, top.perFaction, top.minKills]).toEqual(['top', 3, 1]);
		expect(top.setMessage).toContain('the most on their side');
		expect(validateBounty({ pick: 'whatever' }).pick).toBe('streak');
		expect(() => validateBounty({ pick: 'manual' })).toThrow('at least one player');
		expect(() => validateBounty({ pick: 'manual', wanted: [{ steamId: '123' }] })).toThrow(
			'SteamID64'
		);
		const named = validateBounty({
			pick: 'manual',
			wanted: [{ steamId: A.steamId, name: 'Ace' }, { steamId: A.steamId }, { steamId: B.steamId }]
		});
		expect(named.wanted).toEqual([
			{ steamId: A.steamId, name: 'Ace' },
			{ steamId: B.steamId, name: B.steamId }
		]);
		expect(named.setMessage).toBe('BOUNTY on {name} of {faction}. Kill them for {reward}.');
	});

	test("each side's top killers with enough kills, up to the count on each side", () => {
		const t = fresh();
		const cfg = { pick: 'top' as const, perFaction: 2, minKills: 5 };
		const players = [on(A, 9), on(D, 12), on(E, 7), on(G, 4), on(B, 6), on(C, 3), on(F, 5)];
		const set = bountyPicks(cfg, t, players, at);
		// RED: D and A (E is third); BLUE: B and F (C has too few)
		expect(set.map((b) => b.name)).toEqual([D.name, A.name, B.name, F.name]);
		expect(set[0]).toMatchObject({ faction: RED, streak: 12, how: 'top' });
		// nothing more while both sides are full, whoever passes them
		expect(bountyPicks(cfg, t, [...players, on(G, 30)], at)).toEqual([]);
	});

	test('a claimed bounty frees its side, and its player is passed over until the next match', () => {
		const t = fresh();
		const cfg = { pick: 'top' as const, perFaction: 1, minKills: 3, streak: 99 };
		bountyPicks(cfg, t, [on(A, 10), on(D, 8), on(B, 5)], at);
		expect(t.open.map((b) => b.steamId)).toEqual([A.steamId, B.steamId]);
		// B claims A's: RED's slot opens, and D, not A, is next
		const [claim] = bountyStep(cfg, t, [kill(B, A)], at);
		expect(claim).toMatchObject({ kind: 'claim', bounty: { steamId: A.steamId, how: 'top' } });
		expect(t.claimed.has(A.steamId)).toBe(true);
		expect(bountyPicks(cfg, t, [on(A, 10), on(D, 8), on(B, 6)], at).map((b) => b.name)).toEqual([
			D.name
		]);
		// a kill puts no bounty on a run with this pick
		expect(bountyStep(cfg, t, [kill(C, D), kill(C, E), kill(C, G)], at).map((e) => e.kind)).toEqual(
			['claim']
		);
		expect(claim.kind === 'claim' && runWords(claim.bounty)).toBe('10 kills when marked');
	});

	test('named players are marked while they are on, in the order named, up to the count', () => {
		const t = fresh();
		const cfg = {
			pick: 'manual' as const,
			perFaction: 1,
			wanted: [E, A, B].map((x) => ({ steamId: x.steamId, name: x.name }))
		};
		// E is not on: A is RED's; B is BLUE's
		const set = bountyPicks(cfg, t, [on(A, 0), on(B, 2), on(C, 9)], at);
		expect(set.map((b) => [b.name, b.faction, b.how])).toEqual([
			[A.name, RED, 'manual'],
			[B.name, BLUE, 'manual']
		]);
		expect(runWords(set[0])).toBe('named by the rule');
		// too few on: nobody is marked
		expect(bountyPicks(cfg, fresh(), [on(A, 0)], { ...at, canMark: false })).toEqual([]);
		// a side the panel has not seen is no side
		expect(bountyPicks(cfg, fresh(), [on({ ...A, faction: null }, 0)], at)).toEqual([]);
	});

	test('the replay marks by side from the kills of each match, and starts over at a new one', () => {
		const batch = (at: number, match: string, kills: BountyKill[]) => ({
			kind: 'kills' as const,
			at,
			match,
			players: 50,
			kills
		});
		const { outcomes } = bountyReplay(
			{ pick: 'top', perFaction: 1, minKills: 2, streak: 99, minPlayers: 20 },
			[
				batch(1, 'm1', [kill(A, B), kill(B, D)]),
				batch(2, 'm1', [kill(A, C), kill(B, D)]),
				batch(3, 'm1', [kill(C, A)]),
				batch(4, 'm2', [kill(D, B)])
			]
		);
		expect(outcomes.map((o) => [o.kind, o.at, 'bounty' in o ? o.bounty.name : o.faction])).toEqual([
			['set', 2, A.name],
			['set', 2, B.name],
			['claim', 3, A.name],
			['lapse', 4, B.name]
		]);
	});
});

describe('the Bounty rule, a hunt between the sides', () => {
	const at = { canMark: true, now: 3000 };
	const cfg = {
		pick: 'top' as const,
		perFaction: 3,
		minKills: 1,
		streak: 99,
		reward: 'win' as const,
		winClaims: 2
	};
	const on = (pl: BountyPlayer, kills: number): PickPlayer => ({ ...pl, kills });

	test('the win reward needs a count, says so in its texts and words', () => {
		const c = validateBounty({ reward: 'win', winClaims: 500, pick: 'top' });
		expect([c.reward, c.winClaims]).toEqual(['win', 100]);
		expect(c.setMessage).toContain('First side to {goal} bounties wins the match!');
		expect(validateBounty({ reward: 'win', winMessage: '' }).winMessage).toBe('');
		expect(rewardWords({ reward: 'win', slotDays: 1, winClaims: 3 })).toBe(
			'a point for their side (3 wins the match)'
		);
	});

	test("each claim counts for the claimer's side; the side that reaches the count wins, once", () => {
		const t = fresh();
		bountyPicks(cfg, t, [on(A, 5), on(D, 4), on(B, 3), on(C, 2)], at);
		expect(t.open).toHaveLength(4);
		// BLUE takes A: one for BLUE; RED takes B: one for RED
		const first = bountyStep(cfg, t, [kill(B, A), kill(A, B)], at);
		expect(first.map((e) => [e.kind, e.kind === 'claim' ? e.sideClaims : 0])).toEqual([
			['claim', 1],
			['claim', 1]
		]);
		// BLUE takes D: BLUE's second, and the win
		const won = bountyStep(cfg, t, [kill(C, D)], at);
		expect(won.map((e) => e.kind)).toEqual(['claim', 'win']);
		expect(won[1]).toMatchObject({ kind: 'win', faction: BLUE, claims: 2 });
		expect(t.decided).toBe(true);
		// decided: no more wins, and nobody more is marked this match
		expect(bountyPicks(cfg, t, [on(p(5, RED), 9)], at)).toEqual([]);
		// the next match starts over
		newMatch(t);
		expect([t.wins.size, t.decided, t.claimed.size]).toEqual([0, false, 0]);
	});

	test("the sides' claims and the win are kept on the row", () => {
		const t = fresh();
		t.wins.set(BLUE, 2);
		t.decided = true;
		const state = trackState('v1', t);
		expect(state).toMatchObject({ wins: { [BLUE]: 2 }, decided: true });
		const back = savedBounties(state, 'v1');
		expect([back.wins.get(BLUE), back.decided]).toEqual([2, true]);
	});

	test('the replay tells the win', () => {
		const { outcomes } = bountyReplay({ ...cfg, minPlayers: 0 }, [
			{ kind: 'kills', at: 1, match: 'm1', players: 10, kills: [kill(A, B), kill(C, D)] },
			{ kind: 'kills', at: 2, match: 'm1', players: 10, kills: [kill(B, A), kill(D, C)] },
			{ kind: 'kills', at: 3, match: 'm1', players: 10, kills: [kill(A, B)] }
		]);
		expect(outcomes.filter((o) => o.kind === 'win')).toMatchObject([
			{ kind: 'win', at: 3, faction: RED, claims: 2 }
		]);
	});
});

describe('the Bounty rule, telling the marked player', () => {
	test('a whisper only when the rule has one: the editor starts a new rule with it', () => {
		expect(validateBounty({}).markedWhisper).toBe('');
		expect(validateBounty({ markedWhisper: BOUNTY_MARKED_WHISPER }).markedWhisper).toBe(
			BOUNTY_MARKED_WHISPER
		);
	});
});
