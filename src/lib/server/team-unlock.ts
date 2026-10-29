// The Infection rule's hold on the game's own team lock. With the rule's `unlockTeams` on, the worker
// switches bLockOverpopulatedTeamsConfig off in the config document while the rule is on (the lock
// refuses a team that leads by the threshold, and the infected side always leads), and puts the
// value it found back once the rule is switched off, deleted or told to leave the lock alone. The
// game reads the key at the next match ([/Script/WDGame.WDGameStateSession] applies next-match), so
// the change shows from the match after the write either way: a rule switched off mid-round plays
// that round out unlocked and the lock is back for the match after it.
//
// What the rule found is kept in its row's state ({ unlock }), so a worker that restarts while the
// rule is on, or switched off, still puts it back; a rule deleted while no worker runs is the one
// case it cannot (the row and what it held are gone). The value is put back only while the document
// still holds the one this rule wrote: someone who sets the lock themselves meanwhile is not
// overruled, nor is the rule switching it off a second time after someone switched it back on.
// The pure parts are team-unlock-core.ts; the look's write is keepTeamUnlock, run from observe.ts
// after the rules.
import { and, eq, sql } from 'drizzle-orm';
import { ApiError, forLog } from './http';
import { configResult, readConfig } from './actions';
import { classifyGameError, GameError, type WardogsClient } from './rcon';
import { syncPhrase } from './lists-sync';
import { withOwnedTransaction } from './leadership';
import { writeAudit } from './audit';
import { triggers, type TriggerRow } from './db/schema';
import type { Env } from './env';
import { getScalar, parseIni, setScalarInText } from '../config-doc';
import { lockedKeys, S_STATE } from '../config-fields';
import { TEAM_LOCK_KEY, teamLockFromConfig, type TeamLock } from '../team-lock';
import type { ConfigSection } from '../types';
import {
	restoredValue,
	UNLOCK_EVERY_MS,
	UNLOCK_LASTING_MS,
	UNLOCKED,
	unlockState,
	unlockStep,
	type UnlockMemory,
	type UnlockState,
	type UnlockStep
} from './team-unlock-core';

export * from './team-unlock-core';

// ---- the write ---------------------------------------------------------------------------------

const PINNED =
	"Lock overpopulated teams is pinned on this server's command line, so the panel cannot change it.";

export function unlockRefusal(err: unknown): string {
	if (err instanceof GameError && err.code === 'pinned') return PINNED;
	if (err instanceof GameError && err.code === 'config_readonly')
		return 'The config document is read-only on this server.';
	if (err instanceof ApiError) return syncPhrase(err);
	console.warn('[warcon] infection team lock:', forLog(err));
	return 'The config document could not be written.';
}

const lasting = (err: unknown) =>
	err instanceof GameError &&
	(err.status === 405 || ['pinned', 'config_readonly', 'no_route'].includes(err.code));

const isLockKey = (section: string, key: string) =>
	section.toLowerCase() === S_STATE.toLowerCase() &&
	key.toLowerCase() === TEAM_LOCK_KEY.toLowerCase();

/**
 * One read and, when the step calls for it, one write of the lock line against the revision read.
 * Returns the step taken, the line as found and the document's lock after.
 */
export async function writeTeamLock(
	client: WardogsClient,
	want: boolean,
	held: boolean,
	original: string | null
): Promise<{ step: UnlockStep; found: string | null; lock: TeamLock }> {
	const doc = await readConfig(client);
	const found = getScalar(parseIni(doc.text), S_STATE, TEAM_LOCK_KEY);
	const step = unlockStep(want, held, found);
	if (step !== 'unlock' && step !== 'restore')
		return { step, found, lock: teamLockFromConfig(doc.text) };
	if (!doc.writable)
		throw new GameError(409, 'The config document is read-only.', 'config_readonly');
	if (lockedKeys(doc.sections as ConfigSection[]).some((k) => isLockKey(k.section, k.key)))
		throw new GameError(409, 'bLockOverpopulatedTeamsConfig is pinned.', 'pinned');
	const value = step === 'unlock' ? UNLOCKED : restoredValue(original);
	const text = setScalarInText(doc.text, S_STATE, TEAM_LOCK_KEY, value);
	const { status, body, etag } = await client.configCall('PUT', '/v1/config', text, doc.revision);
	const r = configResult(status, body, etag);
	if (r.conflict)
		throw new GameError(412, 'The config document changed meanwhile.', 'revision_conflict');
	if (!r.ok) {
		const e = classifyGameError('PUT', '/v1/config', status, '', body);
		e.body = null;
		throw e;
	}
	return { step, found, lock: teamLockFromConfig(text) };
}

/** The parts of the worker's memory of a server this reads and moves. */
export interface UnlockLook {
	server: { id: string; name: string; orgId: string };
	holdUntil: number;
	identity: { teamLock?: TeamLock | null };
	teamUnlock: UnlockMemory | null;
	/** the rows' holds have been read once this process (a hold kept by a switched-off rule) */
	teamUnlockRead: boolean;
}

/** A hold a rule switched off (or a worker before this one) left: read once per process. */
async function heldBy(env: Env, serverId: string): Promise<UnlockMemory | null> {
	const rows = await env.db
		.select({ id: triggers.id, state: triggers.state })
		.from(triggers)
		.where(
			and(
				eq(triggers.serverId, serverId),
				eq(triggers.kind, 'infection'),
				sql`${triggers.state} -> 'unlock' ->> 'held' = 'true'`
			)
		)
		.limit(1);
	const s = rows[0] ? unlockState(rows[0].state) : null;
	return s?.held
		? {
				ruleId: rows[0].id,
				held: true,
				original: s.original,
				attemptAt: 0,
				refused: '',
				pending: false
			}
		: null;
}

/** The row's { unlock } part written, the rest of its state as it is (a row since deleted: none). */
async function saveUnlock(env: Env, ruleId: string, state: UnlockState, period: number) {
	await withOwnedTransaction(
		env,
		async (tx) => {
			const unlock = JSON.stringify(state);
			await tx
				.update(triggers)
				.set({
					state: sql`jsonb_set(coalesce(${triggers.state}, '{}'::jsonb), '{unlock}', (${unlock}::text)::jsonb)`
				})
				.where(eq(triggers.id, ruleId));
		},
		{ period }
	);
}

/**
 * One look: the lock switched off for an enabled Infection rule that asks for it, or the value it
 * found put back once none does. The row records what became of it, and each write is audited.
 */
export async function keepTeamUnlock(
	env: Env,
	m: UnlockLook,
	client: WardogsClient,
	rule: TriggerRow | undefined,
	now: number,
	period: number
): Promise<void> {
	if (!m.teamUnlockRead) {
		m.teamUnlock ??= await heldBy(env, m.server.id);
		m.teamUnlockRead = true;
	}
	if (rule) {
		const was = unlockState(rule.state);
		if (!m.teamUnlock || (m.teamUnlock.ruleId !== rule.id && !m.teamUnlock.held))
			m.teamUnlock = {
				ruleId: rule.id,
				held: was?.held ?? false,
				original: was?.original ?? null,
				attemptAt: 0,
				refused: '',
				pending: false
			};
	}
	const mem = m.teamUnlock;
	if (!mem) return;
	const want = !!rule;
	// Nothing to do: on and holding, or off with nothing held. A rule on with the lock already off
	// (by the document) holds nothing and is not tried every minute: the identity says it is off.
	if (want && mem.held) {
		// a rule deleted and another made before a look: the new one takes the hold over
		if (rule && mem.ruleId !== rule.id) {
			mem.ruleId = rule.id;
			const held = { held: true, original: mem.original, at: now, refused: '' };
			await saveUnlock(env, rule.id, held, period);
		}
		return;
	}
	if (!want && !mem.held) {
		m.teamUnlock = null;
		return;
	}
	if (want && m.identity.teamLock && !m.identity.teamLock.on && !mem.refused) return;
	if (now - mem.attemptAt < UNLOCK_EVERY_MS) return;
	mem.attemptAt = now;
	let refused = '';
	let done: Awaited<ReturnType<typeof writeTeamLock>> | null = null;
	try {
		done = await writeTeamLock(client, want, mem.held, mem.original);
	} catch (err) {
		if (err instanceof GameError && err.code === 'rate_limited')
			m.holdUntil = Math.max(m.holdUntil, now + (err.retryAfterMs || 5000));
		if (lasting(err)) mem.attemptAt = now + UNLOCK_LASTING_MS - UNLOCK_EVERY_MS;
		refused = unlockRefusal(err);
	}
	if (done) m.identity.teamLock = done.lock;
	const ruleId = mem.ruleId;
	let state: UnlockState | null = null;
	if (refused) {
		// told once per new reason
		if (refused === mem.refused) return;
		mem.refused = refused;
		state = { held: mem.held, original: mem.original, at: now, refused };
	} else if (done?.step === 'unlock') {
		mem.held = true;
		mem.original = done.found;
		mem.refused = '';
		mem.pending = true;
		state = { held: true, original: done.found, at: now, refused: '' };
	} else if (done?.step === 'restore' || done?.step === 'forget') {
		state = { held: false, original: mem.original, at: now, refused: '' };
		m.teamUnlock = null;
	} else {
		mem.refused = '';
		return;
	}
	await saveUnlock(env, ruleId, state, period);
	if (done?.step === 'unlock' || done?.step === 'restore')
		await writeAudit(env, null, {
			actorName: 'trigger: infection',
			server: { id: m.server.id, name: m.server.name },
			orgId: m.server.orgId,
			category: 'trigger',
			action: 'trigger.team_lock',
			target: TEAM_LOCK_KEY,
			outcome: 'ok',
			message:
				done.step === 'unlock'
					? 'Lock overpopulated teams switched off for Infection (from the next match)'
					: `Lock overpopulated teams put back to ${restoredValue(mem.original)} after Infection (from the next match)`,
			detail: {
				triggerId: ruleId,
				key: TEAM_LOCK_KEY,
				from: done.found,
				to: done.step === 'unlock' ? UNLOCKED : restoredValue(mem.original)
			}
		}).catch((err) => console.error('[warcon] trigger.team_lock audit', forLog(err)));
}
