// The Weather cycle rule: its settings, which lighting comes next (nextLighting), what the worker
// queues at a look (evaluateTriggers), and the change itself, against a stand-in game and the mock.
import { describe, expect, test } from 'bun:test';
import type { Env } from './env';
import { ApiError } from './http';
import { WardogsClient } from './rcon';
import {
	changeWeather,
	lightingName,
	nextLighting,
	validateWeatherCycle,
	WEATHER_CYCLE,
	weatherCycleIndex,
	weatherCycleSettingsKey,
	weatherStep,
	type WeatherLook
} from './weather-cycle';
import { evaluateTriggers, SETTINGS_KEYS, validateConfig, type TickContext } from './triggers';
import type { TriggerRow } from './db/schema';
import type { Status } from '../types';

const MIN = 60_000;
const NOW = Date.UTC(2026, 9, 25, 18, 0, 0);
const THREE = ['DayClear', 'DayLateRain', 'DayLateGray'];

const refused = (raw: Record<string, unknown>): string => {
	try {
		validateWeatherCycle(raw);
	} catch (err) {
		expect(err).toBeInstanceOf(ApiError);
		expect((err as ApiError).status).toBe(400);
		return (err as ApiError).message;
	}
	throw new Error('accepted');
};

describe('settings', () => {
	test('two lightings or more, every 30 min, in order, with someone on, by default', () => {
		expect(validateWeatherCycle({ lightings: THREE })).toEqual({
			lightings: THREE,
			everyMinutes: 30,
			everyChance: 100,
			scoreSteps: [],
			scoreChance: 50,
			matchMinutes: [],
			minutesChance: 50,
			random: false,
			minPlayers: 1
		});
		expect(validateConfig('weather_cycle', { lightings: THREE })).toEqual(
			validateWeatherCycle({ lightings: THREE })
		);
	});

	test('the same lighting twice is kept once, the first way it was written', () => {
		expect(
			validateWeatherCycle({ lightings: ['DayClear', ' dayclear ', 'DayLateRain'] }).lightings
		).toEqual(['DayClear', 'DayLateRain']);
	});

	test('refused: fewer than two, more than twenty, a name that is no id, a time out of range', () => {
		expect(refused({})).toBe('Pick at least two lightings to change between.');
		expect(refused({ lightings: ['DayClear', 'dayClear'] })).toBe(
			'Pick at least two lightings to change between.'
		);
		expect(refused({ lightings: Array.from({ length: 21 }, (_, i) => `Light${i}`) })).toBe(
			'At most 20 lightings.'
		);
		expect(refused({ lightings: ['DayClear', 'Day Late Rain'] })).toBe(
			'"Day Late Rain" is not a lighting: use the ids the server lists, such as DayLateRain.'
		);
		expect(refused({ lightings: ['DayClear', ''] })).toContain('is not a lighting');
		expect(refused({ lightings: ['DayClear', 'x'.repeat(101)] })).toContain('is not a lighting');
		for (const everyMinutes of [4, 1441, -30])
			expect(refused({ lightings: THREE, everyMinutes })).toBe(
				'Change the weather every 5 to 1440 minutes (0: never).'
			);
		expect(refused({ lightings: THREE, everyMinutes: 0 })).toContain(
			'With no scores or minutes into a match'
		);
	});

	test('random only when asked; the player count held to 0-1000', () => {
		const c = (more: Record<string, unknown>) =>
			validateWeatherCycle({ lightings: THREE, ...more });
		expect(c({ random: 'yes' }).random).toBe(false);
		expect(c({ random: true }).random).toBe(true);
		expect(c({ minPlayers: 0 }).minPlayers).toBe(0);
		expect(c({ minPlayers: 5000 }).minPlayers).toBe(1000);
		expect(c({ everyMinutes: 5 }).everyMinutes).toBe(5);
		expect(c({ everyMinutes: '15' }).everyMinutes).toBe(15);
	});

	test('chances, scores and minutes: held to their ranges, each once, lowest first', () => {
		const c = validateWeatherCycle({
			lightings: THREE,
			everyMinutes: 0,
			everyChance: 150,
			scoreSteps: [75, 25, 25, 0, 50, 20000],
			scoreChance: -5,
			matchMinutes: ['10', 5, 700],
			minutesChance: 30
		});
		expect(c.everyMinutes).toBe(0);
		expect(c.everyChance).toBe(100);
		expect(c.scoreSteps).toEqual([25, 50, 75, 10000]);
		expect(c.scoreChance).toBe(0);
		expect(c.matchMinutes).toEqual([5, 10, 600]);
		expect(c.minutesChance).toBe(30);
		expect(
			refused({ lightings: THREE, scoreSteps: Array.from({ length: 21 }, (_, i) => i + 1) })
		).toBe('At most 20 scores.');
	});

	test('a queued change carries the settings it was decided under', () => {
		const a = validateWeatherCycle({ lightings: THREE });
		expect(SETTINGS_KEYS.weather_cycle?.(a)).toBe(weatherCycleSettingsKey(a));
		expect(weatherCycleSettingsKey({ ...a })).toBe(weatherCycleSettingsKey(a));
		expect(weatherCycleSettingsKey({ ...a, lightings: [...THREE].reverse() })).not.toBe(
			weatherCycleSettingsKey(a)
		);
	});
});

describe('nextLighting', () => {
	const inTurn = { lightings: THREE, random: false };

	test('in order from the top, passing over the one the server shows', () => {
		expect(nextLighting(inTurn, -1, 'DayEndClear')).toEqual({ index: 0, lighting: 'DayClear' });
		expect(nextLighting(inTurn, -1, 'DayClear')).toEqual({ index: 1, lighting: 'DayLateRain' });
		expect(nextLighting(inTurn, 0, 'DayClear')).toEqual({ index: 1, lighting: 'DayLateRain' });
		expect(nextLighting(inTurn, 1, 'DayLateRain')).toEqual({ index: 2, lighting: 'DayLateGray' });
		// round to the top again
		expect(nextLighting(inTurn, 2, 'DayLateGray')).toEqual({ index: 0, lighting: 'DayClear' });
		// a new map came up on the next one in the list: the one after it
		expect(nextLighting(inTurn, 0, 'daylaterain')).toEqual({ index: 2, lighting: 'DayLateGray' });
		// a place past the end of a list that has since got shorter
		expect(nextLighting(inTurn, 7, '')).toEqual({ index: 2, lighting: 'DayLateGray' });
	});

	test('at random, any but the one the server shows', () => {
		const random = { lightings: THREE, random: true };
		expect(nextLighting(random, 0, 'DayClear', () => 0)).toEqual({
			index: 1,
			lighting: 'DayLateRain'
		});
		expect(nextLighting(random, 0, 'DayClear', () => 0.9999)).toEqual({
			index: 2,
			lighting: 'DayLateGray'
		});
		expect(nextLighting(random, 0, 'DayEarlyFog', () => 0)).toEqual({
			index: 0,
			lighting: 'DayClear'
		});
		const picks = new Set<string>();
		for (let i = 0; i < 200; i++) picks.add(nextLighting(random, 1, 'DayLateRain')!.lighting);
		expect([...picks].sort()).toEqual(['DayClear', 'DayLateGray']);
	});

	test('nothing when the list holds only the one on', () => {
		for (const random of [false, true])
			expect(nextLighting({ lightings: ['DayClear'], random }, -1, 'DayClear')).toBeNull();
	});

	test('reads back only a place it wrote', () => {
		expect(weatherCycleIndex(null)).toBe(-1);
		expect(weatherCycleIndex({ index: 'x' })).toBe(-1);
		expect(weatherCycleIndex({ index: -3 })).toBe(-1);
		expect(weatherCycleIndex({ index: 1.5 })).toBe(-1);
		expect(weatherCycleIndex({ index: 2 })).toBe(2);
	});

	test('names come from the id', () => {
		expect(lightingName('DayLateRain')).toBe('Day Late Rain');
		expect(lightingName('DayLateGrayFog')).toBe('Day Late Gray Fog');
	});
});

describe('at the look', () => {
	const rule = (config: Record<string, unknown> = { lightings: THREE }) =>
		({
			id: 'rule-1',
			serverId: 'server-1',
			orgId: 'org-1',
			kind: 'weather_cycle',
			name: 'Weather',
			enabled: true,
			config: validateWeatherCycle(config),
			state: null,
			lastFiredAt: null,
			lastResult: ''
		}) as unknown as TriggerRow;
	const look = (row: TriggerRow, at: number, status: Partial<Status> = {}) =>
		evaluateTriggers(
			{} as Env,
			{
				server: { id: 'server-1', name: 'Test' },
				status: {
					map: 'Kavkazi',
					experiences: ['Bakurani_KOTH_02'],
					lighting: 'DayClear',
					alternator: '',
					playerCount: 12,
					scores: [],
					...status
				},
				players: [],
				ts: new Date(at)
			} as unknown as TickContext,
			[row]
		);

	test('at once, then every so many minutes, the next lighting each time', async () => {
		const row = rule();
		const key = weatherCycleSettingsKey(row.config as never);
		let out = await look(row, NOW);
		expect(out.intents).toHaveLength(1);
		expect(out.intents[0]).toMatchObject({
			action: WEATHER_CYCLE,
			params: { rule: key, lighting: 'DayLateRain' },
			target: 'Day Late Rain',
			okMessage: 'Changed the weather to Day Late Rain.',
			detail: { lighting: 'DayLateRain', from: 'DayClear' },
			steamId: null,
			dedupeKey: `rule-1:${NOW}`
		});
		expect(out.updates).toEqual([
			{
				id: 'rule-1',
				lastFiredAt: new Date(NOW),
				lastResult: 'Changing to Day Late Rain',
				state: { index: 1, rolledAt: NOW }
			}
		]);
		// the row moved on with the decision: the looks before the half hour queue nothing
		expect(row.lastFiredAt).toEqual(new Date(NOW));
		for (const at of [NOW + 5_000, NOW + 29 * MIN])
			expect(await look(row, at, { lighting: 'DayLateRain' })).toEqual({
				intents: [],
				updates: []
			});
		out = await look(row, NOW + 30 * MIN, { lighting: 'DayLateRain' });
		expect(out.intents.map((i) => i.params.lighting)).toEqual(['DayLateGray']);
		out = await look(row, NOW + 60 * MIN, { lighting: 'DayLateGray' });
		expect(out.intents.map((i) => i.params.lighting)).toEqual(['DayClear']);
		expect(row.state).toEqual({ index: 0, rolledAt: NOW + 60 * MIN });
	});

	test('nothing below its player count; a rule for 0 changes an empty server too', async () => {
		const row = rule({ lightings: THREE, minPlayers: 10 });
		expect(await look(row, NOW, { playerCount: 9 })).toEqual({ intents: [], updates: [] });
		expect((await look(row, NOW, { playerCount: 10 })).intents).toHaveLength(1);
		const anyone = rule({ lightings: THREE, minPlayers: 0 });
		expect((await look(anyone, NOW, { playerCount: 0 })).intents).toHaveLength(1);
	});

	test('a new map on a lighting of the list: the change passes over it', async () => {
		const row = rule();
		await look(row, NOW, { lighting: 'DayEndClear' });
		expect(row.state).toEqual({ index: 0, rolledAt: NOW });
		// the next map came up on rain, the next in the list
		const out = await look(row, NOW + 30 * MIN, { lighting: 'DayLateRain' });
		expect(out.intents.map((i) => i.params.lighting)).toEqual(['DayLateGray']);
	});

	test('at random: never the lighting on', async () => {
		const row = rule({ lightings: THREE, random: true });
		for (let i = 0; i < 20; i++) {
			// a rule that has never changed it: due at once each time
			row.lastFiredAt = null;
			row.state = null;
			const out = await look(row, NOW + i * MIN, { lighting: 'DayLateGray' });
			expect(['DayClear', 'DayLateRain']).toContain(out.intents[0].params.lighting as string);
		}
	});
});

describe('weatherStep: the dice', () => {
	const cfg = (more: Record<string, unknown>) =>
		validateWeatherCycle({ lightings: THREE, ...more });
	const at = (more: Partial<WeatherLook> = {}): WeatherLook => ({
		now: NOW,
		lead: 0,
		map: 'Kavkazi',
		matchEnded: false,
		matchSeconds: null,
		lastFiredAt: null,
		players: 12,
		...more
	});
	const yes = () => 0;
	const no = () => 0.9999;

	test('the clock rolls at its chance, and waits its minutes whether or not it came up', () => {
		const c = cfg({ everyChance: 40 });
		let s = weatherStep(c, null, at(), no);
		expect(s.rolls).toEqual([{ why: 'every', at: 0, chance: 40, hit: false }]);
		expect(s.change).toBe(false);
		expect(s.state.rolledAt).toBe(NOW);
		expect(weatherStep(c, s.state, at({ now: NOW + 29 * MIN }), yes).dirty).toBe(false);
		s = weatherStep(c, s.state, at({ now: NOW + 30 * MIN }), () => 0.39);
		expect(s.change).toBe(true);
		// 0% never, 100% always, whatever the dice
		expect(weatherStep(cfg({ everyChance: 0 }), null, at(), yes).change).toBe(false);
		expect(weatherStep(cfg({ everyChance: 100 }), null, at(), no).change).toBe(true);
	});

	test('a row from before the chances times the clock from its last change', () => {
		const c = cfg({});
		expect(weatherStep(c, { index: 1 }, at({ lastFiredAt: NOW - 10 * MIN }), yes).dirty).toBe(
			false
		);
		expect(weatherStep(c, { index: 1 }, at({ lastFiredAt: NOW - 30 * MIN }), yes).change).toBe(
			true
		);
	});

	test('each score once a match as the side ahead reaches it, the highest of several', () => {
		const c = cfg({ everyMinutes: 0, scoreSteps: [25, 50, 75], scoreChance: 60 });
		// a match seen starting
		let s = weatherStep(c, null, at({ matchEnded: true }), yes);
		expect(s.rolls).toEqual([]);
		expect(s.state.match).toEqual({ map: 'Kavkazi', from: NOW, scores: [], minutes: [] });
		s = weatherStep(c, s.state, at({ now: NOW + 2 * MIN, lead: 24 }), yes);
		expect(s.dirty).toBe(false);
		s = weatherStep(c, s.state, at({ now: NOW + 3 * MIN, lead: 25 }), no);
		expect(s.rolls).toEqual([{ why: 'score', at: 25, chance: 60, hit: false }]);
		expect(s.change).toBe(false);
		s = weatherStep(c, s.state, at({ now: NOW + 9 * MIN, lead: 80 }), yes);
		expect(s.rolls).toEqual([{ why: 'score', at: 75, chance: 60, hit: true }]);
		expect(s.change).toBe(true);
		expect(s.state.match?.scores).toEqual([25, 50, 75]);
		expect(weatherStep(c, s.state, at({ now: NOW + 10 * MIN, lead: 90 }), yes).dirty).toBe(false);
	});

	test('the scores starting again, or another map, is another match', () => {
		const c = cfg({ everyMinutes: 0, scoreSteps: [25, 50] });
		let s = weatherStep(c, null, at({ matchEnded: true }), yes);
		s = weatherStep(c, s.state, at({ lead: 60 }), yes);
		expect(s.state.match?.scores).toEqual([25, 50]);
		// the end unseen: the side ahead is below a score already rolled
		s = weatherStep(c, s.state, at({ now: NOW + 20 * MIN, lead: 3 }), yes);
		expect(s.rolls).toEqual([]);
		expect(s.state.match?.scores).toEqual([]);
		s = weatherStep(c, s.state, at({ now: NOW + 25 * MIN, lead: 30 }), yes);
		expect(s.rolls.map((r) => r.at)).toEqual([25]);
		s = weatherStep(c, s.state, at({ now: NOW + 26 * MIN, lead: 30, map: 'Ozeti' }), yes);
		expect(s.state.match).toMatchObject({ map: 'Ozeti', scores: [25] });
		expect(s.rolls).toEqual([]);
	});

	test('minutes into the match, from the end seen or the game clock; midway, the past is passed', () => {
		const c = cfg({ everyMinutes: 0, matchMinutes: [5, 10, 20], minutesChance: 100 });
		let s = weatherStep(c, null, at({ matchEnded: true }), no);
		s = weatherStep(c, s.state, at({ now: NOW + 4 * MIN }), no);
		expect(s.dirty).toBe(false);
		s = weatherStep(c, s.state, at({ now: NOW + 5 * MIN }), no);
		expect(s.rolls).toEqual([{ why: 'minutes', at: 5, chance: 100, hit: true }]);
		// the rule came in midway, 12 minutes in by the game's clock: 5 and 10 are passed
		s = weatherStep(c, null, at({ matchSeconds: 12 * 60 }), no);
		expect(s.rolls).toEqual([]);
		expect(s.state.match).toMatchObject({ from: NOW - 12 * MIN, minutes: [5, 10] });
		s = weatherStep(c, s.state, at({ now: NOW + 8 * MIN }), no);
		expect(s.rolls.map((r) => r.at)).toEqual([20]);
	});

	test('below the player count: nothing rolled, the moments passed marked', () => {
		const c = cfg({ scoreSteps: [25], minPlayers: 10 });
		let s = weatherStep(c, null, at({ matchEnded: true, players: 4 }), yes);
		s = weatherStep(c, s.state, at({ now: NOW + MIN, lead: 30, players: 4 }), yes);
		expect(s.rolls).toEqual([]);
		expect(s.state.match?.scores).toEqual([25]);
		expect(s.state.rolledAt).toBeUndefined();
	});

	test('a score or a minute too soon after a change does not change it again', () => {
		const c = cfg({ everyMinutes: 0, scoreSteps: [25] });
		let s = weatherStep(c, null, at({ matchEnded: true }), yes);
		s = weatherStep(c, s.state, at({ now: NOW + MIN, lead: 25, lastFiredAt: NOW + 30_000 }), yes);
		expect(s.rolls[0].hit).toBe(true);
		expect(s.change).toBe(false);
	});
});

describe('at the look: scores', () => {
	test('a score reached changes the weather, said with its chance', async () => {
		const row = {
			id: 'rule-2',
			serverId: 'server-1',
			orgId: 'org-1',
			kind: 'weather_cycle',
			name: 'Weather',
			enabled: true,
			config: validateWeatherCycle({
				lightings: THREE,
				everyMinutes: 0,
				scoreSteps: [50],
				scoreChance: 100
			}),
			state: { match: { map: 'Kavkazi', from: NOW - 10 * MIN, scores: [], minutes: [] } },
			lastFiredAt: null,
			lastResult: ''
		} as unknown as TriggerRow;
		const out = await evaluateTriggers(
			{} as Env,
			{
				server: { id: 'server-1', name: 'Test' },
				status: {
					map: 'Kavkazi',
					experiences: [],
					lighting: 'DayClear',
					alternator: '',
					playerCount: 12,
					scores: [
						{ name: 'Valkyra', colorHex: '', score: 52 },
						{ name: 'Lonestar', colorHex: '', score: 40 }
					]
				},
				players: [],
				ts: new Date(NOW)
			} as unknown as TickContext,
			[row]
		);
		expect(out.intents.map((i) => i.params.lighting)).toEqual(['DayLateRain']);
		expect(out.intents[0].detail).toMatchObject({ why: 'score', at: 50, chance: 100 });
		expect(out.updates[0].lastResult).toBe('Changing to Day Late Rain (score 50, 100%)');
	});
});

// ---- the change at delivery ----

/** A game that lists these lightings and records what it is asked. */
const standIn = (ids: string[], asked: string[]) =>
	({
		json: async (method: string, path: string, body?: unknown) => {
			asked.push(`${method} ${path}${body === undefined ? '' : ` ${JSON.stringify(body)}`}`);
			if (path === '/v1/catalog/lightings')
				return { lightings: ids.map((id) => ({ id, displayName: `${id} (game's own words)` })) };
			if (path === '/v1/world/lighting') return { message: "The game's own words." };
			throw new Error(`unexpected ${method} ${path}`);
		}
	}) as unknown as WardogsClient;

describe('changeWeather', () => {
	test('sent when the server lists it, under the id the server gives it, told in the panel’s words', async () => {
		const asked: string[] = [];
		const got = await changeWeather(standIn(['DayClear', 'DayLateRain'], asked), {
			lighting: 'daylaterain'
		});
		expect(got).toEqual({ message: 'Changed the weather to Day Late Rain.' });
		expect(asked).toEqual([
			'GET /v1/catalog/lightings',
			'PUT /v1/world/lighting {"lighting":"DayLateRain"}'
		]);
	});

	test('a lighting the server does not list is not sent', async () => {
		const asked: string[] = [];
		expect(await changeWeather(standIn(['DayClear'], asked), { lighting: 'DayLateRain' })).toEqual({
			skipped: true,
			message: 'Not sent: Day Late Rain is not among the lightings this server lists.'
		});
		expect(asked).toEqual(['GET /v1/catalog/lightings']);
	});

	test('against the mock game: the status shows the new lighting', async () => {
		const client = new WardogsClient(
			{} as Env,
			{ id: 'weather-test', host: 'demo', port: 1, scheme: 'http' },
			'demo',
			`weather-test-${Date.now()}`
		);
		const status = () => client.json('GET', '/v1/status') as Promise<Status>;
		const from = (await status()).lighting;
		const to = from === 'DayLateRain' ? 'DayEarlyFog' : 'DayLateRain';
		expect(await changeWeather(client, { lighting: to })).toEqual({
			message: `Changed the weather to ${lightingName(to)}.`
		});
		expect((await status()).lighting).toBe(to);
		expect((await changeWeather(client, { lighting: 'NightStorm' })).skipped).toBe(true);
		expect((await status()).lighting).toBe(to);
	});
});
