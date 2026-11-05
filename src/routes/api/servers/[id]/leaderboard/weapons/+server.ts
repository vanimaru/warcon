// The weapon boards: who has the most kills with a weapon, a class of weapons, the vehicles or every
// weapon, on this server or every server of its organisation the caller can see, over a season or
// range, from the stored kill feed; and the weapons ranked by their kills beside it.
// ?scope=server|org&range=current|s:<season>|7d|30d|90d|all&weapon=all|class:<key>|vehicleWeapons|vehicles|cause:<tag>&wsort=kills|headshots|longest&page=1
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { accessibleServers, requireServerCap } from '$lib/server/access';
import { loadWeaponBoard } from '$lib/server/weapon-board';
import { parseWeaponQuery } from '$lib/weapon-board';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server, user } = await requireServerCap(
		env,
		event.locals,
		param(event, 'id'),
		'server.view'
	);
	const q = parseWeaponQuery(event.url.searchParams);
	const ids =
		q.scope === 'org'
			? (await accessibleServers(env, user, server.orgId)).map((s) => s.id)
			: [server.id];
	return apiJson({ ok: true, ...(await loadWeaponBoard(env, ids, q, server.orgId)) });
});
