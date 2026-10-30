import { describe, expect, test } from 'bun:test';
import {
	countedWords,
	countsCause,
	killRaceSpeaks,
	leader,
	newRaceMemory,
	raceAtMatchEnd,
	raceClock,
	raceStep,
	standings,
	syncRaceClock,
	tally,
	validateKillRace,
	type KillerLine
} from './kill-race';

const cfg = validateKillRace({ target: 50, announceEvery: 10 });
const FACTIONS = ['Valkyra', 'Lonestar', 'Manticore'];
const line = (
	steamId: string,
	faction: string,
	kills: number,
	extra: Partial<KillerLine> = {}
): KillerLine => ({ steamId, name: steamId, faction, kills, headshots: 0, teamKills: 0, ...extra });

describe('Kill race settings', () => {
	test('a target the panel sets, 100 by default, within bounds', () => {
		expect(validateKillRace({}).target).toBe(100);
		expect(cfg.target).toBe(50);
		expect(() => validateKillRace({ target: 2 })).toThrow('5 to 5000');
		expect(() => validateKillRace({ target: 9999 })).toThrow();
		expect(validateKillRace({}).timeLimitMinutes).toBe(0);
	});
	test('says nothing with every text blank', () => {
		expect(killRaceSpeaks(cfg)).toBe(true);
		expect(
			killRaceSpeaks(
				validateKillRace({
					startMessage: '',
					progressMessage: '',
					winMessage: '',
					drawMessage: '',
					timeLeftMessage: ''
				})
			)
		).toBe(false);
	});
});

describe('the count', () => {
	test('each side’s kills, every listed side at 0, highest first, with the top killer', () => {
		const t = tally(
			cfg,
			[line('a', 'Valkyra', 7), line('b', 'Valkyra', 5), line('c', 'Lonestar', 9)],
			FACTIONS
		);
		expect(t.sides).toEqual([
			{ faction: 'Valkyra', kills: 12 },
			{ faction: 'Lonestar', kills: 9 },
			{ faction: 'Manticore', kills: 0 }
		]);
		expect(t.top).toEqual({ name: 'c', kills: 9 });
		expect(standings(t)).toBe('Valkyra 12 · Lonestar 9 · Manticore 0');
		expect(leader(t)).toEqual({ faction: 'Valkyra', kills: 12 });
	});
	test('headshots only, and team kills taken off when the rule says', () => {
		const lines = [
			line('a', 'Valkyra', 10, { headshots: 4, teamKills: 3 }),
			line('b', 'Lonestar', 6, { headshots: 6 })
		];
		expect(tally(validateKillRace({ headshotsOnly: true }), lines).sides).toEqual([
			{ faction: 'Lonestar', kills: 6 },
			{ faction: 'Valkyra', kills: 4 }
		]);
		expect(tally(validateKillRace({ teamKillsSubtract: true }), lines).sides[0]).toEqual({
			faction: 'Valkyra',
			kills: 7
		});
	});
	test('a tie at the top, or no kills, has no leader', () => {
		expect(leader(tally(cfg, [line('a', 'Valkyra', 5), line('b', 'Lonestar', 5)]))).toBeNull();
		expect(leader(tally(cfg, [], FACTIONS))).toBeNull();
	});
});

describe('the race', () => {
	const at = (v: number, l: number) =>
		tally(cfg, [line('a', 'Valkyra', v), line('b', 'Lonestar', l)], FACTIONS);

	test('the standings at each step of the leader, once; the win at the target', () => {
		const mem = newRaceMemory('k', 'm1', 1000, false);
		expect(raceStep(cfg, mem, at(3, 1))).toEqual([]);
		expect(raceStep(cfg, mem, at(10, 4)).map((n) => n.kind)).toEqual(['progress']);
		expect(raceStep(cfg, mem, at(11, 4))).toEqual([]);
		// a burst past two steps: told once
		expect(raceStep(cfg, mem, at(31, 20)).map((n) => n.kind)).toEqual(['progress']);
		const win = raceStep(cfg, mem, at(50, 40));
		expect(win).toMatchObject([{ kind: 'win', winner: 'Valkyra', kills: 50, why: 'target' }]);
		// decided: nothing more this match
		expect(raceStep(cfg, mem, at(55, 40))).toEqual([]);
		expect(raceAtMatchEnd(mem)).toEqual([]);
	});

	test('a memory made mid-match (a restart) takes the steps passed as told', () => {
		const mem = newRaceMemory('k', 'm1', 1000, true);
		expect(raceStep(cfg, mem, at(34, 20), true)).toEqual([]);
		expect(raceStep(cfg, mem, at(39, 20))).toEqual([]);
		expect(raceStep(cfg, mem, at(40, 20)).map((n) => n.kind)).toEqual(['progress']);
		// but a target already reached is still the win
		const late = newRaceMemory('k', 'm1', 1000, true);
		expect(raceStep(cfg, late, at(52, 20), true)).toMatchObject([{ kind: 'win' }]);
	});

	test('a match the game ends first is told by its kills', () => {
		const mem = newRaceMemory('k', 'm1', 1000, false);
		raceStep(cfg, mem, at(30, 25));
		expect(raceAtMatchEnd(mem)).toMatchObject([{ kind: 'win', winner: 'Valkyra', why: 'match' }]);
		const tie = newRaceMemory('k', 'm2', 1000, false);
		raceStep(cfg, tie, at(20, 20));
		expect(raceAtMatchEnd(tie)).toMatchObject([{ kind: 'draw', why: 'match' }]);
		const none = newRaceMemory('k', 'm3', 1000, false);
		raceStep(cfg, none, at(0, 0));
		expect(raceAtMatchEnd(none)).toEqual([]);
	});

	test('a time limit: the time left at each warning, then the side ahead wins', () => {
		const timed = validateKillRace({ target: 50, timeLimitMinutes: 10 });
		const T = 1_000_000;
		const min = 60_000;
		const mem = newRaceMemory('k', 'm1', T, false);
		raceStep(timed, mem, at(20, 12));
		expect(raceClock(timed, mem, T + 4 * min)).toEqual([]);
		expect(raceClock(timed, mem, T + 5 * min)).toMatchObject([{ kind: 'time', minutes: 5 }]);
		expect(raceClock(timed, mem, T + 9 * min + 1)).toMatchObject([{ kind: 'time', minutes: 1 }]);
		expect(raceClock(timed, mem, T + 10 * min)).toMatchObject([
			{ kind: 'win', winner: 'Valkyra', kills: 20, why: 'time' }
		]);
		expect(raceClock(timed, mem, T + 11 * min)).toEqual([]);
		// a tie at the limit is a draw
		const tied = newRaceMemory('k', 'm2', T, false);
		raceStep(timed, tied, at(8, 8));
		expect(raceClock(timed, tied, T + 10 * min)).toMatchObject([{ kind: 'draw', why: 'time' }]);
	});

	test('a memory made mid-match is timed from the feed’s match clock', () => {
		const timed = validateKillRace({ timeLimitMinutes: 10 });
		const T = 1_000_000;
		const mem = newRaceMemory('k', 'm1', T, true);
		syncRaceClock(mem, T, 7 * 60);
		expect(mem.clockFrom).toBe(T - 7 * 60_000);
		syncRaceClock(mem, T + 5000, 1);
		expect(mem.clockFrom).toBe(T - 7 * 60_000);
		expect(raceClock(timed, mem, T + 3 * 60_000)).toMatchObject([{ kind: 'draw' }]);
	});
});

describe('the weapons that count', () => {
	test('every weapon unless the rule names some; matched in any case', () => {
		expect(validateKillRace({}).causes).toEqual([]);
		const sniper = validateKillRace({ causes: ['Id.Item.Mosin', 'id.item.mosin', 'Id.Item.SV98'] });
		expect(sniper.causes).toEqual(['Id.Item.Mosin', 'Id.Item.SV98']);
		expect(countsCause(sniper, 'ID.ITEM.MOSIN')).toBe(true);
		expect(countsCause(sniper, 'Id.Item.M4')).toBe(false);
		expect(countsCause(sniper, null)).toBe(false);
		expect(countsCause(validateKillRace({}), null)).toBe(true);
		expect(() => validateKillRace({ causes: ['not a tag!'] })).toThrow('kill feed tag');
	});
	test('said in words for {weapons}', () => {
		expect(countedWords({})).toBe('kills');
		expect(countedWords({ headshotsOnly: true })).toBe('headshots');
		expect(countedWords({ causes: ['Id.Item.Mosin', 'Id.Item.SV98'] })).toBe(
			'kills with Mosin Nagant, SV98'
		);
		expect(
			countedWords({
				headshotsOnly: true,
				causes: ['Id.Item.Mosin', 'Id.Item.SV98', 'Id.Item.MK22', 'Id.Item.SR_04', 'Id.Item.M4']
			})
		).toBe('headshots with Mosin Nagant, SV98, MK22 and 2 more');
	});
});
