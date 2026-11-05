import { describe, expect, test } from 'bun:test';
import {
	ECONOMIC_WAR_GRACE_MS,
	econAtMatchEnd,
	econClock,
	econLeader,
	econLook,
	econRebase,
	econRestore,
	econSaved,
	econStandings,
	econStep,
	econTally,
	economicWarSpeaks,
	newEconMemory,
	syncEconClock,
	validateEconomicWar
} from './economic-war';

const cfg = validateEconomicWar({ target: 10_000, announceEvery: 2_000, milestones: [] });
const TEAMS = ['Valkyra', 'Lonestar', 'Manticore'];
const T0 = 1_000_000;
const p = (steamId: string, faction: string | null, cash: number, kills = 0, deaths = 0) => ({
	steamId,
	name: steamId,
	faction,
	cash,
	kills,
	deaths
});

describe('Economic War settings', () => {
	test('a target the panel sets, 30,000 by default, within bounds', () => {
		expect(validateEconomicWar({}).target).toBe(30_000);
		expect(cfg.target).toBe(10_000);
		expect(() => validateEconomicWar({ target: 500 })).toThrow('1000 to 10000000');
		expect(() => validateEconomicWar({ target: 20_000_000 })).toThrow();
		expect(validateEconomicWar({}).announceEvery).toBe(0);
		expect(validateEconomicWar({}).spendingCounts).toBe(false);
		expect(validateEconomicWar({}).timeLimitMinutes).toBe(0);
		expect(validateEconomicWar({}).timeWarnings).toEqual([5, 1]);
	});
	test('the percentages of the target announced: 25, 50, 75, 90 and 95 by default, 1 to 99', () => {
		expect(validateEconomicWar({}).milestones).toEqual([25, 50, 75, 90, 95]);
		expect(validateEconomicWar({ milestones: [90, 0, 50, 50, 120] }).milestones).toEqual([
			50, 90, 99
		]);
		expect(validateEconomicWar({ milestones: [] }).milestones).toEqual([]);
		expect(() => validateEconomicWar({ milestones: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] })).toThrow(
			'At most 10'
		);
	});
	test('the graces for the starting cash, 30 seconds each by default, 0 to 300', () => {
		const d = validateEconomicWar({});
		expect([d.matchGraceSeconds, d.joinGraceSeconds]).toEqual([30, 30]);
		const set = validateEconomicWar({ matchGraceSeconds: 0, joinGraceSeconds: 90 });
		expect([set.matchGraceSeconds, set.joinGraceSeconds]).toEqual([0, 90]);
		expect(validateEconomicWar({ matchGraceSeconds: 999 }).matchGraceSeconds).toBe(300);
		expect(validateEconomicWar({ joinGraceSeconds: -5 }).joinGraceSeconds).toBe(0);
	});
	test('says nothing with every text blank', () => {
		expect(economicWarSpeaks(cfg)).toBe(true);
		expect(
			economicWarSpeaks(
				validateEconomicWar({
					startMessage: '',
					progressMessage: '',
					milestoneMessage: '',
					winMessage: '',
					drawMessage: '',
					timeLeftMessage: ''
				})
			)
		).toBe(false);
	});
});

describe('Economic War count', () => {
	test("a player's first look only sets where they start from", () => {
		const mem = newEconMemory('k', 'Ozeti', T0, false);
		expect(econLook(mem, [p('a', 'Valkyra', 800)], TEAMS, T0)).toBe(false);
		expect(econTally(mem, TEAMS).sides.every((s) => s.cash === 0)).toBe(true);
		expect(econLook(mem, [p('a', 'Valkyra', 950)], TEAMS, T0 + 2000)).toBe(true);
		expect(econTally(mem, TEAMS).sides[0]).toEqual({ faction: 'Valkyra', cash: 150 });
	});
	test('money spent is not taken off, and the next rise counts from there', () => {
		const mem = newEconMemory('k', 'Ozeti', T0, false);
		econLook(mem, [p('a', 'Valkyra', 1000)], TEAMS, T0);
		econLook(mem, [p('a', 'Valkyra', 1300)], TEAMS, T0 + 2000); // +300
		econLook(mem, [p('a', 'Valkyra', 100)], TEAMS, T0 + 4000); // bought a vehicle
		econLook(mem, [p('a', 'Valkyra', 250)], TEAMS, T0 + 6000); // +150
		expect(econTally(mem, TEAMS).sides[0].cash).toBe(450);
	});
	test('with spending counted, a drop while the counters hold is taken off', () => {
		const mem = newEconMemory('k', 'Ozeti', T0, false);
		const look = (cash: number, kills: number, deaths: number, at: number) =>
			econLook(mem, [p('a', 'Valkyra', cash, kills, deaths)], TEAMS, T0 + at, 0, true);
		look(1000, 2, 1, 0);
		look(1600, 4, 1, 2000); // +600
		look(400, 4, 1, 4000); // bought a vehicle: -1200
		// shown as nothing earned, while the count below 0 waits to be earned back
		expect(econTally(mem, TEAMS).sides.find((x) => x.faction === 'Valkyra')?.cash).toBe(0);
		expect(mem.sides.get('Valkyra')).toBe(-600);
		expect(econTally(mem, TEAMS).top).toBeNull();
		look(1400, 6, 1, 6000); // +1000
		expect(mem.sides.get('Valkyra')).toBe(400);
		expect(econTally(mem, TEAMS).top).toEqual({ name: 'a', cash: 400 });
		// the scoreboard started again (a reconnect): the drop is not spending
		look(0, 0, 0, 8000);
		look(300, 1, 0, 10_000);
		expect(mem.sides.get('Valkyra')).toBe(700);
	});
	test('a rise goes to the side the player is on now; no side earns for nobody', () => {
		const mem = newEconMemory('k', 'Ozeti', T0, false);
		econLook(mem, [p('a', 'Valkyra', 0), p('b', null, 0)], TEAMS, T0);
		econLook(mem, [p('a', 'Valkyra', 200), p('b', null, 500)], TEAMS, T0 + 2000);
		econLook(mem, [p('a', 'Lonestar', 300), p('b', 'Holding', 900)], TEAMS, T0 + 4000);
		const t = econTally(mem, TEAMS);
		expect(Object.fromEntries(t.sides.map((s) => [s.faction, s.cash]))).toEqual({
			Valkyra: 200,
			Lonestar: 100,
			Manticore: 0
		});
		expect(t.top).toEqual({ name: 'a', cash: 300 });
	});
	test('a player who leaves keeps what they earned on their side, and starts again on return', () => {
		const mem = newEconMemory('k', 'Ozeti', T0, false);
		econLook(mem, [p('a', 'Valkyra', 0)], TEAMS, T0);
		econLook(mem, [p('a', 'Valkyra', 400)], TEAMS, T0 + 2000);
		econLook(mem, [], TEAMS, T0 + 4000);
		econLook(mem, [p('a', 'Valkyra', 1000)], TEAMS, T0 + 6000); // back: a first look again
		expect(econTally(mem, TEAMS).sides[0].cash).toBe(400);
	});
	test("the match's first seconds hand out the starting cash, which nobody earned", () => {
		const mem = newEconMemory('k', 'Ozeti', T0, true);
		econLook(mem, [p('a', 'Valkyra', 0)], TEAMS, T0);
		econLook(mem, [p('a', 'Valkyra', 2000)], TEAMS, T0 + 2000);
		expect(econTally(mem, TEAMS).sides[0].cash).toBe(0);
		econLook(mem, [p('a', 'Valkyra', 2150)], TEAMS, T0 + ECONOMIC_WAR_GRACE_MS + 1);
		expect(econTally(mem, TEAMS).sides[0].cash).toBe(150);
	});
	test("the match's grace is the rule's", () => {
		const mem = newEconMemory('k', 'Ozeti', T0, true, 60_000);
		econLook(mem, [p('a', 'Valkyra', 0)], TEAMS, T0);
		econLook(mem, [p('a', 'Valkyra', 2000)], TEAMS, T0 + 45_000);
		expect(econTally(mem, TEAMS).sides[0].cash).toBe(0);
		const none = newEconMemory('k', 'Ozeti', T0, true, 0);
		econLook(none, [p('a', 'Valkyra', 0)], TEAMS, T0);
		econLook(none, [p('a', 'Valkyra', 150)], TEAMS, T0 + 2000);
		expect(econTally(none, TEAMS).sides[0].cash).toBe(150);
	});
	test("a late joiner's first seconds on a side are their starting cash", () => {
		const mem = newEconMemory('k', 'Ozeti', T0, false);
		const GRACE = 30_000;
		// a player on a side at the first look is no late joiner
		econLook(mem, [p('a', 'Valkyra', 0)], TEAMS, T0, GRACE);
		econLook(mem, [p('a', 'Valkyra', 100)], TEAMS, T0 + 2000, GRACE);
		// b joins in the menu, takes a side, then gets the starting cash
		econLook(mem, [p('a', 'Valkyra', 100), p('b', null, 0)], TEAMS, T0 + 4000, GRACE);
		econLook(mem, [p('a', 'Valkyra', 100), p('b', 'Lonestar', 0)], TEAMS, T0 + 6000, GRACE);
		econLook(mem, [p('a', 'Valkyra', 100), p('b', 'Lonestar', 2000)], TEAMS, T0 + 8000, GRACE);
		expect(econTally(mem, TEAMS).sides.find((s) => s.faction === 'Lonestar')?.cash).toBe(0);
		// after the grace, b earns
		econLook(mem, [p('a', 'Valkyra', 100), p('b', 'Lonestar', 2150)], TEAMS, T0 + 36_001, GRACE);
		const t = econTally(mem, TEAMS);
		expect(t.sides.find((s) => s.faction === 'Lonestar')?.cash).toBe(150);
		expect(t.sides.find((s) => s.faction === 'Valkyra')?.cash).toBe(100);
		// a switch of side is no new join
		econLook(mem, [p('a', 'Valkyra', 100), p('b', 'Manticore', 2150)], TEAMS, T0 + 38_000, GRACE);
		econLook(mem, [p('a', 'Valkyra', 100), p('b', 'Manticore', 2300)], TEAMS, T0 + 40_000, GRACE);
		expect(econTally(mem, TEAMS).sides.find((s) => s.faction === 'Manticore')?.cash).toBe(150);
		// gone and back: a late joiner again
		econLook(mem, [p('a', 'Valkyra', 100)], TEAMS, T0 + 42_000, GRACE);
		econLook(mem, [p('a', 'Valkyra', 100), p('b', 'Manticore', 0)], TEAMS, T0 + 44_000, GRACE);
		econLook(mem, [p('a', 'Valkyra', 100), p('b', 'Manticore', 2000)], TEAMS, T0 + 46_000, GRACE);
		expect(econTally(mem, TEAMS).sides.find((s) => s.faction === 'Manticore')?.cash).toBe(150);
	});
	test('after an outage everyone starts again from their cash then', () => {
		const mem = newEconMemory('k', 'Ozeti', T0, false);
		econLook(mem, [p('a', 'Valkyra', 0)], TEAMS, T0);
		econRebase(mem);
		econLook(mem, [p('a', 'Valkyra', 5000)], TEAMS, T0 + 60_000);
		expect(econTally(mem, TEAMS).sides[0].cash).toBe(0);
	});
	test('standings and the leader', () => {
		const mem = newEconMemory('k', 'Ozeti', T0, false);
		mem.sides.set('Valkyra', 12_400);
		mem.sides.set('Lonestar', 9_850);
		const t = econTally(mem, TEAMS);
		expect(econStandings(t)).toBe('Valkyra $12,400 · Lonestar $9,850 · Manticore $0');
		expect(econLeader(t)?.faction).toBe('Valkyra');
		mem.sides.set('Lonestar', 12_400);
		expect(econLeader(econTally(mem, TEAMS))).toBeNull();
	});
});

describe('Economic War news', () => {
	const at = (sides: Record<string, number>) => {
		const mem = newEconMemory('k', 'Ozeti', T0, false);
		for (const [f, n] of Object.entries(sides)) mem.sides.set(f, n);
		return mem;
	};
	test('the standings once per step passed, the highest', () => {
		const mem = at({ Valkyra: 1_500 });
		expect(econStep(cfg, mem, econTally(mem, TEAMS))).toEqual([]);
		mem.sides.set('Valkyra', 6_100);
		const news = econStep(cfg, mem, econTally(mem, TEAMS));
		expect(news.map((n) => n.kind)).toEqual(['progress']);
		expect(mem.step).toBe(3);
		expect(econStep(cfg, mem, econTally(mem, TEAMS))).toEqual([]);
	});
	test('each percentage of the target once, as the leader first reaches it, the highest', () => {
		const pct = validateEconomicWar({ target: 10_000 });
		const mem = at({ Valkyra: 2_400 });
		expect(econStep(pct, mem, econTally(mem, TEAMS))).toEqual([]);
		mem.sides.set('Valkyra', 2_500);
		expect(econStep(pct, mem, econTally(mem, TEAMS))[0]).toMatchObject({
			kind: 'milestone',
			percent: 25,
			leader: 'Valkyra'
		});
		mem.sides.set('Lonestar', 9_100); // past 50, 75 and 90 at once
		const news = econStep(pct, mem, econTally(mem, TEAMS));
		expect(news).toHaveLength(1);
		expect(news[0]).toMatchObject({ kind: 'milestone', percent: 90, leader: 'Lonestar' });
		expect(econStep(pct, mem, econTally(mem, TEAMS))).toEqual([]);
		mem.sides.set('Lonestar', 10_000);
		expect(econStep(pct, mem, econTally(mem, TEAMS))[0]).toMatchObject({ kind: 'win' });
	});
	test('a memory made mid-match takes the percentages passed as said', () => {
		const pct = validateEconomicWar({ target: 10_000 });
		const mem = at({ Valkyra: 5_200 });
		expect(econStep(pct, mem, econTally(mem, TEAMS), true)).toEqual([]);
		expect([...mem.milestonesTold]).toEqual([25, 50]);
		mem.sides.set('Valkyra', 7_600);
		expect(econStep(pct, mem, econTally(mem, TEAMS))[0]).toMatchObject({ percent: 75 });
	});
	test('a memory made mid-match takes the steps passed as said', () => {
		const mem = at({ Valkyra: 6_100 });
		expect(econStep(cfg, mem, econTally(mem, TEAMS), true)).toEqual([]);
		expect(mem.step).toBe(3);
	});
	test('the target wins, once', () => {
		const mem = at({ Valkyra: 10_050, Lonestar: 4_000 });
		const news = econStep(cfg, mem, econTally(mem, TEAMS));
		expect(news).toHaveLength(1);
		expect(news[0]).toMatchObject({ kind: 'win', winner: 'Valkyra', cash: 10_050, why: 'target' });
		expect(mem.decided).toBe(true);
		expect(econStep(cfg, mem, econTally(mem, TEAMS))).toEqual([]);
		// nothing more is counted once decided
		econLook(mem, [p('a', 'Lonestar', 0)], TEAMS, T0);
		expect(econLook(mem, [p('a', 'Lonestar', 9_000)], TEAMS, T0 + 2000)).toBe(false);
	});
	test('the time limit: warnings, then the side ahead wins, or a draw', () => {
		const timed = validateEconomicWar({ target: 10_000, timeLimitMinutes: 20 });
		const mem = at({ Valkyra: 3_000, Lonestar: 2_000 });
		const t = econTally(mem, TEAMS);
		expect(econClock(timed, mem, t, T0 + 14 * 60_000)).toEqual([]);
		expect(econClock(timed, mem, t, T0 + 15 * 60_000)[0]).toMatchObject({
			kind: 'time',
			minutes: 5
		});
		expect(econClock(timed, mem, t, T0 + 16 * 60_000)).toEqual([]);
		expect(econClock(timed, mem, t, T0 + 20 * 60_000)[0]).toMatchObject({
			kind: 'win',
			winner: 'Valkyra',
			why: 'time'
		});
		const tie = at({ Valkyra: 3_000, Lonestar: 3_000 });
		expect(econClock(timed, tie, econTally(tie, TEAMS), T0 + 21 * 60_000)[0]).toMatchObject({
			kind: 'draw',
			why: 'time'
		});
	});
	test("the game's own end tells the money as it stood", () => {
		const mem = at({ Lonestar: 7_000, Valkyra: 2_000 });
		expect(econAtMatchEnd(mem, econTally(mem, TEAMS))[0]).toMatchObject({
			kind: 'win',
			winner: 'Lonestar',
			why: 'match'
		});
		const none = at({});
		expect(econAtMatchEnd(none, econTally(none, TEAMS))).toEqual([]);
	});
	test("the game's match clock, when sent, times a memory made mid-match", () => {
		const mem = newEconMemory('k', 'Ozeti', T0, false);
		syncEconClock(mem, T0, 300);
		expect(mem.clockFrom).toBe(T0 - 300_000);
		expect(mem.clockGuessed).toBe(false);
		const fromStart = newEconMemory('k', 'Ozeti', T0, true);
		syncEconClock(fromStart, T0 + 5000, 300);
		expect(fromStart.clockFrom).toBe(T0);
	});
});

describe('Economic War across a restart', () => {
	test('the saved count comes back for the same match and map only', () => {
		const mem = newEconMemory('k', 'Ozeti', T0, false);
		econLook(mem, [p('a', 'Valkyra', 0)], TEAMS, T0);
		econLook(mem, [p('a', 'Valkyra', 4_200)], TEAMS, T0 + 2000);
		mem.step = 2;
		mem.milestonesTold.add(25);
		const saved = JSON.parse(JSON.stringify(econSaved(mem, 41)));
		const back = newEconMemory('k', 'Ozeti', T0 + 90_000, false);
		expect(econRestore(back, saved, 41)).toBe(true);
		expect(back.match).toBe(mem.match);
		expect(econTally(back, TEAMS).sides[0]).toEqual({ faction: 'Valkyra', cash: 4_200 });
		expect(back.step).toBe(2);
		expect([...back.milestonesTold]).toEqual([25]);
		expect(back.clockFrom).toBe(T0);
		expect(econRestore(newEconMemory('k', 'Ozeti', T0, false), saved, 42)).toBe(false);
		expect(econRestore(newEconMemory('k', 'Bakurani', T0, false), saved, 41)).toBe(false);
		expect(econRestore(newEconMemory('k', 'Ozeti', T0, false), null, 41)).toBe(false);
		expect(econRestore(newEconMemory('k', 'Ozeti', T0, false), saved, null)).toBe(false);
	});
});
