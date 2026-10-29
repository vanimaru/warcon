// The pure part of the Infection rule's hold on the game's team lock (team-unlock.ts says when and
// why): what a look should do with the lock line, what a rule row keeps of it, and the row's note.
import type { TeamLock } from '../team-lock';
import type { TriggerRow } from './db/schema';

/** The fewest milliseconds between two tries, and between two tries the server refuses for good. */
export const UNLOCK_EVERY_MS = 60_000;
export const UNLOCK_LASTING_MS = 10 * 60_000;
/** What the rule writes, as the game's own documents spell a bool. */
export const UNLOCKED = 'False';

/** The lock's line read as on or off; absent is the game's default, on. */
export const lockOn = (raw: string | null): boolean =>
	raw === null ? true : !/^(false|0|no|off)$/i.test(raw.trim());

/** What an Infection row's state keeps of the lock (null when it has never held it). */
export interface UnlockState {
	/** the rule has switched the lock off and not yet put it back */
	held: boolean;
	/** the line as the rule found it (null: the document did not have it, the game's default on) */
	original: string | null;
	/** when it was switched off, or put back (ms) */
	at: number;
	/** a fixed phrase: why the latest try wrote nothing ('' when it wrote) */
	refused: string;
}

export function unlockState(state: unknown): UnlockState | null {
	const u =
		state && typeof state === 'object' ? (state as Record<string, unknown>).unlock : undefined;
	if (!u || typeof u !== 'object') return null;
	const s = u as Record<string, unknown>;
	return {
		held: s.held === true,
		original: typeof s.original === 'string' ? s.original : null,
		at: typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : 0,
		refused: typeof s.refused === 'string' ? s.refused : ''
	};
}

/** Whether a rule row asks for the lock to be off: an Infection rule with Unlock teams ticked. */
export const wantsUnlock = (row: Pick<TriggerRow, 'kind' | 'config'>): boolean =>
	row.kind === 'infection' &&
	!!row.config &&
	typeof row.config === 'object' &&
	(row.config as Record<string, unknown>).unlockTeams === true;

/** What the worker remembers of a server's hold between looks. */
export interface UnlockMemory {
	/** the rule that holds (or last asked for) the lock */
	ruleId: string;
	held: boolean;
	original: string | null;
	attemptAt: number;
	/** the phrase last recorded for a failed try */
	refused: string;
	/** a write this process made, waiting for the next match to take effect */
	pending: boolean;
}

export type UnlockStep = 'unlock' | 'restore' | 'forget' | 'none';

/**
 * What the document calls for, read just before the write. `want`: an enabled rule asks for the lock
 * off. The rule switches it off once per hold, never against someone who switched it on again since,
 * and puts back only what it wrote.
 */
export function unlockStep(want: boolean, held: boolean, raw: string | null): UnlockStep {
	const on = lockOn(raw);
	if (want) return held ? 'none' : on ? 'unlock' : 'none';
	if (!held) return 'none';
	return on ? 'forget' : 'restore';
}

/** The value put back: the line the rule found, or the game's default when there was none. */
export const restoredValue = (original: string | null): string => original ?? 'True';

/** The note an Infection row carries about the lock, beside how the round stands ('' for none). */
export function unlockNote(
	cfgUnlock: boolean,
	lock: TeamLock | null | undefined,
	mem: UnlockMemory | null
): string {
	if (cfgUnlock && mem?.refused) return `Lock overpopulated teams not switched off: ${mem.refused}`;
	if (cfgUnlock && mem?.held && mem.pending)
		return 'Lock overpopulated teams switched off: it takes effect from the next match';
	if (!lock?.on) return '';
	if (cfgUnlock && mem?.held)
		return 'Warning: Lock overpopulated teams was switched on again since this rule switched it off, so moves onto the infected side can be refused: the rule leaves it as set';
	return cfgUnlock
		? 'Switching Lock overpopulated teams off in the config document'
		: `Warning: the game locks a team ${lock.threshold} ahead (Lock overpopulated teams), so moves onto the infected side can be refused: tick Unlock teams, or switch it off on the Config tab`;
}
