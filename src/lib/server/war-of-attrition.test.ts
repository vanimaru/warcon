import { describe, expect, test } from 'bun:test';
import {
	attritionAtMatchEnd,
	attritionClock,
	attritionSpeaks,
	attritionStandings,
	attritionStep,
	attritionTally,
	newAttritionMemory,
	syncAttritionClock,
	validateAttrition,
	type DeathLine
} from './war-of-attrition';

const T0 = 1_000_000;
const MIN = 60_000;
const TWO = validateAttrition({ limit: 50, leftOut: 'Manticore', milestones: [50, 90] });
const FACTIONS = ['Valkyra', 'Lonestar', 'Manticore'];
const line = (faction: string, deaths: number, selfInflicted = 0): DeathLine => ({
	faction,
	deaths,
	selfInflicted
});

describe('War of Attrition settings', () => {
	test('a limit the panel sets, 100 by default, within bounds', () => {
		const d = validateAttrition({ leftOut: 'Manticore' });
		expect(d.limit).toBe(100);
		expect(d.leftOut).toBe('Manticore');
		expect(d.countSelfInflicted).toBe(false);
		expect(d.milestones).toEqual([50, 75, 90]);
		expect(d.timeLimitMinutes).toBe(0);
		expect(d.timeWarnings).toEqual([5, 1]);
		expect(() => validateAttrition({ limit: 4, leftOut: 'Manticore' })).toThrow('5 to 5000');
		expect(() => validateAttrition({ limit: 5001, leftOut: 'Manticore' })).toThrow();
		expect(
			validateAttrition({ leftOut: 'Manticore', milestones: [90, 50, 50, 0, 150] }).milestones
		).toEqual([50, 90, 99]);
	});
	test('two sides only: a rule that leaves no faction out is refused', () => {
		for (const leftOut of [undefined, '', '   '])
			expect(() => validateAttrition({ limit: 50, leftOut })).toThrow(
				'Name the faction left out: the war is fought by two sides.'
			);
	});
	test('says nothing with every text blank', () => {
		expect(attritionSpeaks(TWO)).toBe(true);
		expect(
			attritionSpeaks(
				validateAttrition({
					leftOut: 'Manticore',
					startMessage: '',
					milestoneMessage: '',
					winMessage: '',
					timeWinMessage: '',
					drawMessage: '',
					timeLeftMessage: ''
				})
			)
		).toBe(false);
	});
});

describe('War of Attrition count', () => {
	test('the side left out is not counted; the others start at 0', () => {
		const t = attritionTally(TWO, [line('Valkyra', 7), line('Manticore', 30)], FACTIONS);
		expect(t.sides).toEqual([
			{ faction: 'Lonestar', deaths: 0 },
			{ faction: 'Valkyra', deaths: 7 }
		]);
		expect(attritionStandings(t, 50)).toBe('Lonestar 0/50 · Valkyra 7/50');
	});
	test('deaths by their own hand or the world count only when the rule says', () => {
		const lines = [line('Valkyra', 10, 4)];
		expect(attritionTally(TWO, lines, FACTIONS).sides.at(-1)?.deaths).toBe(10);
		const all = validateAttrition({ limit: 50, leftOut: 'Manticore', countSelfInflicted: true });
		expect(attritionTally(all, lines, FACTIONS).sides.at(-1)?.deaths).toBe(14);
	});
});

describe('War of Attrition news', () => {
	const mem = () => newAttritionMemory('k', 'm1', T0, false);
	test('a side out of lives loses, and the other wins, once', () => {
		const m = mem();
		const t = attritionTally(TWO, [line('Valkyra', 50), line('Lonestar', 31)], FACTIONS);
		const news = attritionStep(TWO, m, t);
		expect(news).toEqual([
			{ kind: 'win', winner: 'Lonestar', loser: 'Valkyra', tally: t, why: 'limit' }
		]);
		expect(attritionStep(TWO, m, t)).toEqual([]);
	});
	test('the side left out never wins, whatever its deaths', () => {
		const t = attritionTally(
			TWO,
			[line('Valkyra', 50), line('Lonestar', 20), line('Manticore', 0)],
			FACTIONS
		);
		expect(attritionStep(TWO, mem(), t)[0]).toMatchObject({
			kind: 'win',
			winner: 'Lonestar',
			loser: 'Valkyra'
		});
	});
	test('each percentage of the limit once, as the side with the most deaths reaches it', () => {
		const m = mem();
		const at = (v: number, l: number) =>
			attritionStep(
				TWO,
				m,
				attritionTally(TWO, [line('Valkyra', v), line('Lonestar', l)], FACTIONS)
			);
		expect(at(20, 10)).toEqual([]);
		expect(at(25, 10)[0]).toMatchObject({
			kind: 'milestone',
			faction: 'Valkyra',
			deaths: 25,
			percent: 50
		});
		expect(at(26, 10)).toEqual([]);
		// past 90 on the other side: announced for whoever reached it
		expect(at(30, 46)[0]).toMatchObject({ kind: 'milestone', faction: 'Lonestar', percent: 90 });
		expect(at(30, 48)).toEqual([]);
	});
	test('a memory made mid-match takes the percentages passed as said', () => {
		const m = mem();
		const t = attritionTally(TWO, [line('Valkyra', 30)], FACTIONS);
		expect(attritionStep(TWO, m, t, true)).toEqual([]);
		expect([...m.told]).toEqual([50]);
	});
	test('the time limit: warnings, then the fewest deaths win, or a draw', () => {
		const timed = validateAttrition({ limit: 50, leftOut: 'Manticore', timeLimitMinutes: 20 });
		const m = mem();
		attritionStep(
			timed,
			m,
			attritionTally(timed, [line('Valkyra', 9), line('Lonestar', 12)], FACTIONS)
		);
		expect(attritionClock(timed, m, T0 + 14 * MIN)).toEqual([]);
		expect(attritionClock(timed, m, T0 + 15 * MIN)[0]).toMatchObject({ kind: 'time', minutes: 5 });
		expect(attritionClock(timed, m, T0 + 20 * MIN)[0]).toMatchObject({
			kind: 'win',
			winner: 'Valkyra',
			loser: null,
			why: 'time'
		});
		const tie = mem();
		attritionStep(
			timed,
			tie,
			attritionTally(timed, [line('Valkyra', 9), line('Lonestar', 9)], FACTIONS)
		);
		expect(attritionClock(timed, tie, T0 + 21 * MIN)[0]).toMatchObject({
			kind: 'draw',
			why: 'time'
		});
	});
	test("the game's own end tells the deaths as they stood", () => {
		const m = mem();
		attritionStep(TWO, m, attritionTally(TWO, [line('Valkyra', 9), line('Lonestar', 4)], FACTIONS));
		expect(attritionAtMatchEnd(m)[0]).toMatchObject({
			kind: 'win',
			winner: 'Lonestar',
			why: 'match'
		});
		const none = mem();
		attritionStep(TWO, none, attritionTally(TWO, [], FACTIONS));
		expect(attritionAtMatchEnd(none)).toEqual([]);
	});
	test("the feed's match clock times a memory made mid-match", () => {
		const m = newAttritionMemory('k', 'm1', T0, true);
		syncAttritionClock(m, T0, 300);
		expect(m.clockFrom).toBe(T0 - 300_000);
		expect(m.clockGuessed).toBe(false);
	});
});
