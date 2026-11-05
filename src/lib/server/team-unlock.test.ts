import { describe, expect, test } from 'bun:test';
import {
	lockOn,
	restoredValue,
	unlockNote,
	unlockState,
	unlockStep,
	wantsUnlock,
	type UnlockMemory
} from './team-unlock-core';

const mem = (over: Partial<UnlockMemory> = {}): UnlockMemory => ({
	ruleId: 'r1',
	held: false,
	original: null,
	attemptAt: 0,
	refused: '',
	pending: false,
	...over
});
const ON = { on: true, threshold: 2 };
const OFF = { on: false, threshold: 2 };

describe('the lock line', () => {
	test('absent is the game’s default, on; False, 0, no, off are off', () => {
		expect(lockOn(null)).toBe(true);
		expect(lockOn('True')).toBe(true);
		for (const v of ['False', 'false', '0', 'no', 'Off ']) expect(lockOn(v)).toBe(false);
	});
	test('what goes back: the line found, or True for none', () => {
		expect(restoredValue('true')).toBe('true');
		expect(restoredValue(null)).toBe('True');
	});
});

describe('what a look does', () => {
	test('a rule on switches an on lock off, once per hold', () => {
		expect(unlockStep(true, false, null)).toBe('unlock');
		expect(unlockStep(true, false, 'True')).toBe('unlock');
		// already off: nothing to hold
		expect(unlockStep(true, false, 'False')).toBe('none');
		// held, and switched on again by someone: left as they set it
		expect(unlockStep(true, true, 'True')).toBe('none');
	});
	test('a rule off puts back what it wrote, and only that', () => {
		expect(unlockStep(false, true, 'False')).toBe('restore');
		// someone switched it on meanwhile: the hold is dropped, the document left
		expect(unlockStep(false, true, 'True')).toBe('forget');
		expect(unlockStep(false, false, 'False')).toBe('none');
	});
});

describe('the row', () => {
	test('a hold read from the state, nothing from none', () => {
		expect(unlockState(null)).toBeNull();
		expect(unlockState({ enabledAt: 1 })).toBeNull();
		expect(unlockState({ unlock: { held: true, original: 'True', at: 5, refused: '' } })).toEqual({
			held: true,
			original: 'True',
			at: 5,
			refused: ''
		});
		expect(unlockState({ unlock: { held: true, original: 7 } })?.original).toBeNull();
	});
	test('only an Infection rule with Unlock teams ticked asks for it', () => {
		expect(wantsUnlock({ kind: 'infection', config: { unlockTeams: true } })).toBe(true);
		expect(wantsUnlock({ kind: 'infection', config: { unlockTeams: false } })).toBe(false);
		expect(wantsUnlock({ kind: 'infection', config: {} })).toBe(false);
		expect(wantsUnlock({ kind: 'two_teams', config: { unlockTeams: true } })).toBe(false);
	});
	test('the note: switching, switched for the next match, refused, switched on again, or warned', () => {
		expect(unlockNote(true, ON, null)).toContain('Switching');
		expect(unlockNote(true, OFF, mem({ held: true, pending: true }))).toContain('next match');
		expect(unlockNote(true, OFF, mem({ held: true }))).toBe('');
		const refused = mem({ refused: 'The config document is read-only on this server.' });
		expect(unlockNote(true, ON, refused)).toContain('read-only');
		expect(unlockNote(true, ON, mem({ held: true }))).toContain('switched on again');
		expect(unlockNote(false, ON, null)).toContain('tick Unlock teams');
		expect(unlockNote(false, OFF, null)).toBe('');
	});
});
