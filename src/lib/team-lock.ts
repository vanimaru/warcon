// The game's own lock on a side that has too many players: with bLockOverpopulatedTeamsConfig on
// (the default), a team ahead of the others by OverpopulatedTeamThresholdConfig (2 by default) takes
// no more players. Read from the config document, which every build serves. Client-safe.
import { getScalar, parseIni } from './config-doc';
import { S_STATE } from './config-fields';

export interface TeamLock {
	on: boolean;
	/** how many players ahead a team must be before it locks */
	threshold: number;
}

export const TEAM_LOCK_KEY = 'bLockOverpopulatedTeamsConfig';
export const TEAM_LOCK_THRESHOLD_KEY = 'OverpopulatedTeamThresholdConfig';

/** The lock as the document sets it, the game's defaults (on, 2) for what it leaves out. */
export function teamLockFromConfig(text: string): TeamLock {
	const doc = parseIni(text);
	const on = getScalar(doc, S_STATE, TEAM_LOCK_KEY);
	const threshold = Number(getScalar(doc, S_STATE, TEAM_LOCK_THRESHOLD_KEY)?.trim());
	return {
		on: on === null ? true : !/^(false|0|no|off)$/i.test(on.trim()),
		threshold: Number.isInteger(threshold) && threshold >= 0 ? threshold : 2
	};
}
