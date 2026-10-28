import { describe, expect, test } from 'bun:test';
import {
	INFECTION_LATE_MS,
	INFECTION_MAX_MOVES_PER_LOOK,
	INFECTION_REASK_MS,
	INFECTION_SETUP_WAIT_MS,
	infectionKills,
	infectionLook,
	infectionSpeaks,
	newInfectionMemory,
	patientCount,
	roundCounts,
	roundNews,
	roundResult,
	validateInfection,
	type InfectionConfig,
	type InfectionPlayer
} from './infection';

const FACTIONS = ['Valkyra', 'Lonestar', 'Manticore'];
const cfg: InfectionConfig = validateInfection({
	infectedFaction: 'Manticore',
	survivorFaction: 'Lonestar',
	startInfected: 1,
	minPlayers: 4
});
const p = (n: number, faction: string | null): InfectionPlayer => ({
	steamId: `7656119800000${String(n).padStart(4, '0')}`,
	name: `P${n}`,
	faction
});
/** the first draw always: the first player picked */
const first = () => 0;

describe('Infection settings', () => {
	test('two different factions, a count of first infected, texts defaulted', () => {
		expect(cfg.infectedFaction).toBe('Manticore');
		expect(cfg.startInfected).toBe(1);
		expect(cfg.startMessage).toContain('{patients}');
		expect(() =>
			validateInfection({ infectedFaction: 'Lonestar', survivorFaction: 'lonestar' })
		).toThrow('two different factions');
		expect(() => validateInfection({ infectedFaction: '', survivorFaction: 'Lonestar' })).toThrow();
		expect(validateInfection({ ...cfg, startInfected: 99 }).startInfected).toBe(30);
	});
	test('a rule with every text blank says nothing, so it needs no Chat', () => {
		expect(infectionSpeaks(cfg)).toBe(true);
		expect(
			infectionSpeaks(
				validateInfection({
					...cfg,
					startMessage: '',
					infectWhisper: '',
					infectBroadcast: '',
					fewLeftMessage: '',
					lastSurvivorMessage: '',
					allInfectedMessage: '',
					survivorsWinMessage: '',
					infectedWinMessage: ''
				})
			)
		).toBe(false);
	});
});

describe('a round', () => {
	test('a new rule takes the server as it is: the infected side infected, the round on', () => {
		const mem = newInfectionMemory('k');
		const players = [p(1, 'Manticore'), p(2, 'Lonestar'), p(3, 'Lonestar'), p(4, 'Valkyra')];
		const look = infectionLook(cfg, mem, {
			players,
			factions: FACTIONS,
			matchEnded: false,
			now: 0
		});
		expect(mem.phase).toBe('running');
		expect(mem.roles.get(p(1, null).steamId)).toBe('infected');
		// the third faction is put on the survivors' side; nobody else moves
		expect(look.moves.map((m) => [m.name, m.to])).toEqual([['P4', 'Lonestar']]);
		expect(look.news).toEqual([]);
	});

	test('with nobody infected, a round starts: the patients picked, everyone else a survivor', () => {
		const mem = newInfectionMemory('k');
		const players = [p(1, 'Lonestar'), p(2, 'Valkyra'), p(3, 'Lonestar'), p(4, 'Lonestar')];
		const look = infectionLook(cfg, mem, {
			players,
			factions: FACTIONS,
			matchEnded: false,
			now: 1000,
			rand: first
		});
		expect(mem.phase).toBe('running');
		expect(look.news).toEqual([{ kind: 'start', patients: [players[0]] }]);
		expect(look.moves.map((m) => [m.name, m.to, m.why])).toEqual([
			['P1', 'Manticore', 'start'],
			['P2', 'Lonestar', 'start']
		]);
		expect(look.result).toBe('Round started: P1 infected');
	});

	test('waits for enough players, and for most of them to pick a side', () => {
		const mem = newInfectionMemory('k');
		const few = [p(1, 'Lonestar'), p(2, 'Lonestar')];
		let look = infectionLook(cfg, mem, {
			players: few,
			factions: FACTIONS,
			matchEnded: false,
			now: 0
		});
		expect(look.result).toBe('Waiting for 4 players');
		const unpicked = [p(1, 'Lonestar'), p(2, 'Lonestar'), p(3, null), p(4, null)];
		look = infectionLook(cfg, mem, {
			players: unpicked,
			factions: FACTIONS,
			matchEnded: false,
			now: 1
		});
		expect(mem.phase).toBe('waiting');
		expect(look.moves).toEqual([]);
		// ... or for the wait
		look = infectionLook(cfg, mem, {
			players: unpicked,
			factions: FACTIONS,
			matchEnded: false,
			now: 1 + INFECTION_SETUP_WAIT_MS,
			rand: first
		});
		expect(mem.phase).toBe('running');
		expect(look.news[0]).toMatchObject({ kind: 'start' });
	});

	test('a match without the rule’s factions waits, and says so', () => {
		const mem = newInfectionMemory('k');
		const look = infectionLook(cfg, mem, {
			players: [p(1, 'Valkyra'), p(2, 'Lonestar'), p(3, 'Lonestar'), p(4, 'Lonestar')],
			factions: ['Valkyra', 'Lonestar'],
			matchEnded: false,
			now: 0
		});
		expect(look.result).toBe('Waiting: this match has no Manticore faction');
		expect(look.moves).toEqual([]);
	});

	test('an infected player’s kill of a survivor infects them; other kills do not', () => {
		const mem = newInfectionMemory('k');
		const players = [p(1, 'Manticore'), p(2, 'Lonestar'), p(3, 'Lonestar'), p(4, 'Lonestar')];
		infectionLook(cfg, mem, { players, factions: FACTIONS, matchEnded: false, now: 0 });
		const kill = (
			id: string,
			killer: InfectionPlayer | null,
			victim: InfectionPlayer,
			suicide = false
		) => ({
			eventId: id,
			killer,
			victim,
			suicide
		});
		const { infected } = infectionKills(
			cfg,
			mem,
			[
				kill('a', players[2], players[0]), // a survivor kills the infected: nothing
				kill('b', players[1], players[2]), // a survivor kills a survivor: nothing
				kill('c', null, players[3]), // the environment
				kill('d', players[0], players[1]), // infected!
				kill('e', players[0], players[1]) // already infected
			],
			5000
		);
		expect(infected.map((i) => [i.victim.name, i.killer.name, i.eventId])).toEqual([
			['P2', 'P1', 'd']
		]);
		expect(mem.roles.get(players[1].steamId)).toBe('infected');
		// the next look does not ask again while the feed's move is on its way
		const look = infectionLook(cfg, mem, {
			players,
			factions: FACTIONS,
			matchEnded: false,
			now: 6000
		});
		expect(look.moves).toEqual([]);
		expect(roundCounts(mem, players)).toEqual({ infected: 2, survivors: 2 });
	});

	test('the last survivor is told once, and the round ends with none', () => {
		const mem = newInfectionMemory('k');
		const players = [p(1, 'Manticore'), p(2, 'Manticore'), p(3, 'Lonestar'), p(4, 'Lonestar')];
		infectionLook(cfg, mem, { players, factions: FACTIONS, matchEnded: false, now: 0 });
		infectionKills(
			cfg,
			mem,
			[{ eventId: 'x', killer: players[0], victim: players[2], suicide: false }],
			1
		);
		expect(roundNews(cfg, mem, players)).toEqual([{ kind: 'last', survivor: players[3] }]);
		expect(roundNews(cfg, mem, players)).toEqual([]);
		infectionKills(
			cfg,
			mem,
			[{ eventId: 'y', killer: players[1], victim: players[3], suicide: false }],
			2
		);
		expect(roundNews(cfg, mem, players)).toEqual([{ kind: 'all' }]);
		expect(mem.phase).toBe('over');
		// over: no more infections, no more news, until the match ends
		expect(roundNews(cfg, mem, players)).toEqual([]);
	});

	test('a player who switches is put back; a survivor who joins the infected stays infected', () => {
		const mem = newInfectionMemory('k');
		const players = [p(1, 'Manticore'), p(2, 'Lonestar'), p(3, 'Lonestar'), p(4, 'Lonestar')];
		infectionLook(cfg, mem, { players, factions: FACTIONS, matchEnded: false, now: 0 });
		const switched = [p(1, 'Lonestar'), p(2, 'Manticore'), p(3, 'Lonestar'), p(4, 'Lonestar')];
		const look = infectionLook(cfg, mem, {
			players: switched,
			factions: FACTIONS,
			matchEnded: false,
			now: 10_000
		});
		expect(look.moves.map((m) => [m.name, m.to, m.why])).toEqual([['P1', 'Manticore', 'back']]);
		expect(mem.roles.get(players[1].steamId)).toBe('infected');
		// asked once; again only after the wait
		expect(
			infectionLook(cfg, mem, {
				players: switched,
				factions: FACTIONS,
				matchEnded: false,
				now: 20_000
			}).moves
		).toEqual([]);
		expect(
			infectionLook(cfg, mem, {
				players: switched,
				factions: FACTIONS,
				matchEnded: false,
				now: 10_000 + INFECTION_REASK_MS
			}).moves.map((m) => m.name)
		).toEqual(['P1']);
	});

	test('a late joiner joins the infected; one at the start is a survivor', () => {
		const mem = newInfectionMemory('k');
		const players = [p(1, 'Lonestar'), p(2, 'Lonestar'), p(3, 'Lonestar'), p(4, 'Lonestar')];
		infectionLook(cfg, mem, {
			players,
			factions: FACTIONS,
			matchEnded: false,
			now: 0,
			rand: first
		});
		const early = [...players, p(5, 'Valkyra')];
		let look = infectionLook(cfg, mem, {
			players: early,
			factions: FACTIONS,
			matchEnded: false,
			now: 5000
		});
		expect(look.moves.find((m) => m.name === 'P5')).toMatchObject({ to: 'Lonestar' });
		const late = [...early, p(6, 'Lonestar')];
		look = infectionLook(cfg, mem, {
			players: late,
			factions: FACTIONS,
			matchEnded: false,
			now: INFECTION_LATE_MS + 1
		});
		expect(look.moves.find((m) => m.name === 'P6')).toMatchObject({ to: 'Manticore', why: 'late' });
	});

	test('a new match starts a new round, whatever the last one came to', () => {
		const mem = newInfectionMemory('k');
		const players = [p(1, 'Manticore'), p(2, 'Manticore'), p(3, 'Manticore'), p(4, 'Manticore')];
		// everyone on the infected side: the round taken as it is, and it is over
		infectionLook(cfg, mem, { players, factions: FACTIONS, matchEnded: false, now: 0 });
		expect(mem.phase).toBe('over');
		const round = mem.round;
		const look = infectionLook(cfg, mem, {
			players,
			factions: FACTIONS,
			matchEnded: true,
			now: 100_000,
			rand: first
		});
		expect(mem.round).toBeGreaterThan(round);
		// the last round's result, then the new round
		expect(look.news[0]).toMatchObject({ kind: 'result', infectedWon: true });
		expect(look.news[1]).toEqual({ kind: 'start', patients: [players[0]] });
		expect(look.moves.map((m) => m.to)).toEqual(['Lonestar', 'Lonestar', 'Lonestar']);
	});

	test('a full server is sorted a few moves a look', () => {
		const mem = newInfectionMemory('k');
		const players = Array.from({ length: 30 }, (_, i) => p(i, 'Valkyra'));
		const look = infectionLook(cfg, mem, {
			players,
			factions: FACTIONS,
			matchEnded: false,
			now: 0,
			rand: first
		});
		expect(look.moves.length).toBe(INFECTION_MAX_MOVES_PER_LOOK);
		const next = infectionLook(cfg, mem, {
			players,
			factions: FACTIONS,
			matchEnded: false,
			now: 2000
		});
		expect(next.moves.length).toBe(INFECTION_MAX_MOVES_PER_LOOK);
		expect(new Set([...look.moves, ...next.moves].map((m) => m.steamId)).size).toBe(
			2 * INFECTION_MAX_MOVES_PER_LOOK
		);
	});
});

describe('a full server of 100', () => {
	const open = validateInfection({ infectedFaction: 'Manticore', minPlayers: 10 });
	const full = (n: number, faction: (i: number) => string) =>
		Array.from({ length: n }, (_, i) => p(i, faction(i)));

	test('a new rule leaves the survivors on either other side, one infected in ten', () => {
		expect(open.survivorFaction).toBe('');
		expect(open.perPlayers).toBe(10);
		expect(patientCount(open, 100)).toBe(10);
		expect(patientCount(open, 15)).toBe(1);
		expect(patientCount(validateInfection({ ...open, perPlayers: 2 }), 100)).toBe(30);
		expect(patientCount(validateInfection({ ...open, startInfected: 5, perPlayers: 0 }), 3)).toBe(
			2
		);
	});

	test('only the first infected move at the start; the rest keep the side they picked', () => {
		const mem = newInfectionMemory('k');
		// a new match after a round the infection won: everyone on Manticore but a few
		const players = full(100, (i) => (i < 50 ? 'Valkyra' : 'Lonestar'));
		let rand = 0.99;
		const look = infectionLook(open, mem, {
			players,
			factions: FACTIONS,
			matchEnded: true,
			now: 0,
			perLook: 100,
			rand: () => (rand = (rand * 7.3) % 1)
		});
		const start = look.news[0];
		expect(start.kind).toBe('start');
		expect(start.kind === 'start' && start.patients.length).toBe(10);
		expect(look.moves.length).toBe(10);
		expect(look.moves.every((m) => m.to === 'Manticore')).toBe(true);
		expect(roundCounts(mem, players)).toEqual({ infected: 10, survivors: 90 });
	});

	test('survivors left on the infected side go to the side with the fewest survivors', () => {
		const mem = newInfectionMemory('k');
		const players = [
			...full(6, () => 'Valkyra'),
			...full(2, () => 'Lonestar').map((q, i) => ({ ...q, steamId: `x${i}` })),
			...full(4, () => 'Manticore').map((q, i) => ({ ...q, steamId: `z${i}` }))
		];
		const look = infectionLook(open, mem, {
			players,
			factions: FACTIONS,
			matchEnded: true,
			now: 0,
			perLook: 100,
			rand: first
		});
		// the four on Manticore are survivors now (the patient is the first Valkyra player)
		const back = look.moves.filter((m) => m.to !== 'Manticore');
		expect(back.map((m) => m.to)).toEqual(['Lonestar', 'Lonestar', 'Lonestar', 'Valkyra']);
	});

	test('the survivors left are announced at each count once, the lowest when a burst passes several', () => {
		const mem = newInfectionMemory('k');
		const players = full(40, (i) => (i < 30 ? 'Valkyra' : 'Manticore'));
		infectionLook(open, mem, { players, factions: FACTIONS, matchEnded: false, now: 0 });
		const infect = (n: number) => {
			const victims = players.filter((q) => mem.roles.get(q.steamId) === 'survivor').slice(0, n);
			infectionKills(
				open,
				mem,
				victims.map((v, i) => ({
					eventId: `${v.steamId}${i}`,
					killer: players[39],
					victim: v,
					suicide: false
				})),
				1
			);
		};
		infect(4); // 26 left
		expect(roundNews(open, mem, players)).toEqual([]);
		infect(1); // 25
		expect(roundNews(open, mem, players)).toEqual([{ kind: 'few', survivors: 25 }]);
		expect(roundNews(open, mem, players)).toEqual([]);
		infect(19); // 6: past 10, said with the count as it is
		expect(roundNews(open, mem, players)).toEqual([{ kind: 'few', survivors: 6 }]);
		infect(3); // 3: past 5
		expect(roundNews(open, mem, players)).toEqual([{ kind: 'few', survivors: 3 }]);
		infect(2);
		expect(roundNews(open, mem, players)).toMatchObject([{ kind: 'last' }]);
	});

	test('a round that starts below a count never announces it', () => {
		const mem = newInfectionMemory('k');
		// 12 on: one infected, 11 survivors, below 25 already
		const players = full(12, () => 'Valkyra');
		infectionLook(open, mem, {
			players,
			factions: FACTIONS,
			matchEnded: false,
			now: 0,
			rand: first
		});
		expect(mem.milestonesTold.has(25)).toBe(true);
		expect(mem.milestonesTold.has(10)).toBe(false);
		expect(mem.milestonesTold.has(5)).toBe(false);
	});
});

describe('the game’s own win, in the infection’s words', () => {
	const open = validateInfection({ infectedFaction: 'Manticore', minPlayers: 4 });
	const players = [p(1, 'Manticore'), p(2, 'Lonestar'), p(3, 'Lonestar'), p(4, 'Valkyra')];
	const started = () => {
		const mem = newInfectionMemory('k');
		infectionLook(open, mem, { players, factions: FACTIONS, matchEnded: false, now: 0 });
		return mem;
	};

	test('a survivors’ side ahead as the match ends: the survivors won', () => {
		const mem = started();
		// the list empties as the match ends: the counts are the last look's
		const look = infectionLook(open, mem, {
			players: [],
			factions: FACTIONS,
			matchEnded: true,
			winner: 'Lonestar',
			now: 60_000
		});
		expect(look.news[0]).toEqual({
			kind: 'result',
			infectedWon: false,
			winner: 'Lonestar',
			infected: 1,
			survivors: 3,
			top: null
		});
		expect(look.result).toBe('Match over: the survivors won');
		expect(mem.phase).toBe('waiting');
	});

	test('the infected ahead: the infection won, with its top infector', () => {
		const mem = started();
		infectionKills(
			open,
			mem,
			[
				{ eventId: 'a', killer: players[0], victim: players[1], suicide: false },
				{ eventId: 'b', killer: players[1], victim: players[2], suicide: false },
				{ eventId: 'c', killer: players[0], victim: players[3], suicide: false }
			],
			1
		);
		roundNews(open, mem, players);
		const r = roundResult(open, mem, 'Manticore');
		expect(r).toMatchObject({ infectedWon: true, top: { name: 'P1', count: 2 } });
	});

	test('nobody left uninfected is the infection’s win, whoever led on points', () => {
		const mem = started();
		infectionKills(
			open,
			mem,
			players
				.slice(1)
				.map((v, i) => ({ eventId: `${i}`, killer: players[0], victim: v, suicide: false })),
			1
		);
		expect(roundNews(open, mem, players)).toEqual([{ kind: 'all' }]);
		expect(roundResult(open, mem, 'Lonestar')).toMatchObject({ infectedWon: true, survivors: 0 });
	});

	test('a tie or a match nobody scored: no side named; no round, no result', () => {
		expect(roundResult(open, started(), null)).toMatchObject({ infectedWon: null });
		expect(roundResult(open, newInfectionMemory('k'), 'Lonestar')).toBeNull();
	});
});
