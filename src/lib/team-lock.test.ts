import { describe, expect, test } from 'bun:test';
import { teamLockFromConfig } from './team-lock';

describe('the game’s lock on overpopulated teams', () => {
	test('on, two ahead, when the document says nothing', () => {
		expect(teamLockFromConfig('[/Script/WDGame.WDGameSession]\nServerName=Demo\n')).toEqual({
			on: true,
			threshold: 2
		});
	});
	test('as the document sets it', () => {
		const text = [
			'[/Script/WDGame.WDGameStateSession]',
			'bLockOverpopulatedTeamsConfig=False',
			'OverpopulatedTeamThresholdConfig=6'
		].join('\n');
		expect(teamLockFromConfig(text)).toEqual({ on: false, threshold: 6 });
		expect(teamLockFromConfig(text.replace('False', 'True'))).toEqual({ on: true, threshold: 6 });
	});
});
