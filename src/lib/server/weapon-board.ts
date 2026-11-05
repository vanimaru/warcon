// The weapon boards: who has the most kills with a weapon, a class of weapons, or every weapon, over
// a server or the organisation's servers and a season or range, read straight from the stored kill
// feed (kills: one row per kill, its cause tag, headshot and distance). A kill of another side only:
// suicides, team kills and the environment are left out. Beside the board, the weapons themselves
// ranked by their kills over the same servers and window. A page is kept for a minute, as the
// player boards are.
import { sql } from 'drizzle-orm';
import type { Env } from './env';
import { orgSeasons, pickable, resolveWindow } from './seasons';
import { causeLabel, WEAPON_CLASSES } from '$lib/causes';
import {
	WEAPON_BOARD_PAGE,
	type WeaponBoardQuery,
	type WeaponBoardView,
	type WeaponPick
} from '$lib/weapon-board';

const TTL_MS = 60_000;
const CACHE_MAX = 200;
const cache = new Map<string, { until: number; view: Promise<Omit<WeaponBoardView, 'seasons'>> }>();

/** The SQL that keeps a kill under the pick: every weapon, a class, vehicles, or one weapon. */
function pickFilter(pick: WeaponPick) {
	if (pick.kind === 'all') return sql``;
	if (pick.kind === 'class') {
		const tags = WEAPON_CLASSES.find((c) => c.key === pick.key)?.tags ?? [];
		if (!tags.length) return sql`AND false`;
		return sql`AND lower(k.cause) IN (${sql.join(
			tags.map((t) => sql`${t.toLowerCase()}`),
			sql`, `
		)})`;
	}
	if (pick.kind === 'vehicleWeapons')
		return sql`AND lower(k.cause) LIKE 'id.vehicle.weaponextension.%'`;
	if (pick.kind === 'vehicles') return sql`AND lower(k.cause) LIKE 'vehicle.%'`;
	return sql`AND lower(k.cause) = ${pick.cause.toLowerCase()}`;
}

const ORDER = {
	kills: sql`kills DESC`,
	headshots: sql`headshots DESC, kills DESC`,
	longest: sql`longest DESC NULLS LAST, kills DESC`
} as const;

export async function loadWeaponBoard(
	env: Env,
	ids: string[],
	q: WeaponBoardQuery,
	orgId: string
): Promise<WeaponBoardView> {
	const now = Date.now();
	const os = await orgSeasons(env, orgId);
	const win = resolveWindow(q.range, os, now);
	const seasons = pickable(os, now);
	const sorted = [...new Set(ids)].sort();
	const key = JSON.stringify([sorted, q, win.range, win.finished]);
	const hit = cache.get(key);
	if (hit && hit.until > now) return { ...(await hit.view), seasons };
	const view = read(env, sorted, q, win.from, win.to).then((body) => ({
		query: q,
		when: { range: win.range, season: win.season, finished: win.finished },
		...body
	}));
	cache.delete(key);
	cache.set(key, { until: now + TTL_MS, view });
	view.catch(() => cache.get(key)?.view === view && cache.delete(key));
	if (cache.size > CACHE_MAX)
		for (const [k, e] of cache) if (e.until <= now || cache.size > CACHE_MAX) cache.delete(k);
	return { ...(await view), seasons };
}

async function read(
	env: Env,
	ids: string[],
	q: WeaponBoardQuery,
	from: Date | null,
	to: Date | null
): Promise<Pick<WeaponBoardView, 'rows' | 'total' | 'pageSize' | 'weapons'>> {
	if (!ids.length) return { rows: [], total: 0, pageSize: WEAPON_BOARD_PAGE, weapons: [] };
	const window = sql`k.server_id IN ${ids}
		${from ? sql`AND k.ts >= ${from}` : sql``} ${to ? sql`AND k.ts < ${to}` : sql``}
		AND k.killer_steam_id IS NOT NULL AND NOT k.suicide AND NOT k.team_kill`;
	const offset = (q.page - 1) * WEAPON_BOARD_PAGE;
	const [players, weapons] = await Promise.all([
		env.db.execute<{
			steamId: string;
			name: string | null;
			kills: number;
			headshots: number;
			longest: number | null;
			topCause: string | null;
			total: number;
		}>(sql`
			WITH per AS (
				SELECT k.killer_steam_id AS sid, MAX(k.killer_name) AS name, COUNT(*)::int AS kills,
				       COUNT(*) FILTER (WHERE k.headshot)::int AS headshots,
				       MAX(k.distance_m) AS longest,
				       mode() WITHIN GROUP (ORDER BY k.cause) AS top_cause
				  FROM kills k
				 WHERE ${window} ${pickFilter(q.weapon)}
				 GROUP BY k.killer_steam_id)
			SELECT sid AS "steamId", name, kills, headshots, longest, top_cause AS "topCause",
			       COUNT(*) OVER ()::int AS total
			  FROM per
			 ORDER BY ${ORDER[q.sort]}, sid
			 LIMIT ${WEAPON_BOARD_PAGE} OFFSET ${offset}`),
		env.db.execute<{ cause: string; kills: number; headshots: number; longest: number | null }>(sql`
			SELECT k.cause, COUNT(*)::int AS kills, COUNT(*) FILTER (WHERE k.headshot)::int AS headshots,
			       MAX(k.distance_m) AS longest
			  FROM kills k
			 WHERE ${window} AND k.cause IS NOT NULL
			 GROUP BY k.cause
			 ORDER BY kills DESC, k.cause
			 LIMIT 40`)
	]);
	return {
		rows: players.map((r, i) => ({
			rank: offset + i + 1,
			steamId: r.steamId,
			name: r.name || r.steamId,
			kills: Number(r.kills),
			headshots: Number(r.headshots),
			longestM: r.longest === null ? null : Math.round(Number(r.longest)),
			topWeapon: r.topCause ? causeLabel(r.topCause) : null
		})),
		total: players.length ? Number(players[0].total) : 0,
		pageSize: WEAPON_BOARD_PAGE,
		weapons: weapons.map((w) => ({
			cause: w.cause,
			label: causeLabel(w.cause),
			kills: Number(w.kills),
			headshots: Number(w.headshots),
			longestM: w.longest === null ? null : Math.round(Number(w.longest))
		}))
	};
}
