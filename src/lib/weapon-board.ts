// The weapon boards' query and answer: who has the most kills with a weapon, a class of them, the
// vehicles or every weapon, over a season or range, and the weapons ranked beside it. The server
// side is $lib/server/weapon-board. Client-safe.
import { WEAPON_CLASSES } from './causes';
import {
	DEFAULT_BOARD_QUERY,
	parseBoardQuery,
	type BoardRange,
	type BoardScope,
	type BoardWhen
} from './leaderboard';
import type { Season } from './seasons';

export const WEAPON_BOARD_PAGE = 50;

/** What a board counts: every weapon, a class of them, the vehicles' weapons, vehicles, or one tag. */
export type WeaponPick =
	| { kind: 'all' }
	| { kind: 'class'; key: string }
	| { kind: 'vehicleWeapons' }
	| { kind: 'vehicles' }
	| { kind: 'cause'; cause: string };

export type WeaponSort = 'kills' | 'headshots' | 'longest';

export interface WeaponBoardQuery {
	scope: BoardScope;
	range: BoardRange;
	weapon: WeaponPick;
	sort: WeaponSort;
	/** 1-based */
	page: number;
}

export interface WeaponBoardRow {
	rank: number;
	steamId: string;
	name: string;
	kills: number;
	headshots: number;
	/** the longest of those kills in metres, when the feed sent a distance */
	longestM: number | null;
	/** the weapon they killed with most, of the ones counted */
	topWeapon: string | null;
}

export interface WeaponStat {
	cause: string;
	label: string;
	kills: number;
	headshots: number;
	longestM: number | null;
}

export interface WeaponBoardView {
	query: WeaponBoardQuery;
	when: BoardWhen;
	seasons: Season[];
	rows: WeaponBoardRow[];
	/** players with a kill counted over the whole board */
	total: number;
	pageSize: number;
	/** the weapons with the most kills over the same servers and window, whatever is picked */
	weapons: WeaponStat[];
}

const TAG_RE = /^[A-Za-z0-9_.-]{1,200}$/;

/** `all`, `class:sniper`, `vehicleWeapons`, `vehicles` or `cause:Id.Item.Mosin`, read back. */
export function parseWeaponPick(v: string | null): WeaponPick {
	if (!v || v === 'all') return { kind: 'all' };
	if (v === 'vehicleWeapons' || v === 'vehicles') return { kind: v };
	if (v.startsWith('class:') && WEAPON_CLASSES.some((c) => c.key === v.slice(6)))
		return { kind: 'class', key: v.slice(6) };
	if (v.startsWith('cause:') && TAG_RE.test(v.slice(6)))
		return { kind: 'cause', cause: v.slice(6) };
	return { kind: 'all' };
}

export const weaponPickParam = (p: WeaponPick): string =>
	p.kind === 'class' ? `class:${p.key}` : p.kind === 'cause' ? `cause:${p.cause}` : p.kind;

export function parseWeaponQuery(params: URLSearchParams): WeaponBoardQuery {
	const base = parseBoardQuery(params);
	const sort = params.get('wsort');
	return {
		scope: base.scope,
		range: base.range,
		weapon: parseWeaponPick(params.get('weapon')),
		sort: sort === 'headshots' || sort === 'longest' ? sort : 'kills',
		page: base.page
	};
}

/** The query as parameters, defaults left out. */
export function weaponQueryParams(q: WeaponBoardQuery): Record<string, string> {
	const out: Record<string, string> = {};
	if (q.scope !== 'server') out.scope = q.scope;
	if (q.range !== DEFAULT_BOARD_QUERY.range) out.range = q.range;
	if (q.weapon.kind !== 'all') out.weapon = weaponPickParam(q.weapon);
	if (q.sort !== 'kills') out.wsort = q.sort;
	if (q.page !== 1) out.page = String(q.page);
	return out;
}
