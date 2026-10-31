<script lang="ts">
	// The weapon boards: the players with the most kills with a weapon, a class of weapons, the
	// vehicles or every weapon, over the season or range picked, and the weapons themselves ranked
	// beside it (a click on one shows its board). Read from the stored kill feed; one read per
	// change of the controls.
	import SeasonPicker from '$lib/components/SeasonPicker.svelte';
	import { api, errorMessage, qs } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import { fmtNum } from '$lib/format';
	import { causeKind, knownCauses, WEAPON_CLASSES } from '$lib/causes';
	import {
		parseWeaponPick,
		weaponPickParam,
		weaponQueryParams,
		type WeaponBoardQuery,
		type WeaponBoardView,
		type WeaponSort
	} from '$lib/weapon-board';

	let {
		serverId,
		query,
		onchange,
		hrefFor,
		orgName = ''
	}: {
		serverId: string;
		query: WeaponBoardQuery;
		onchange: (q: WeaponBoardQuery) => void;
		hrefFor: (steamId: string) => string;
		orgName?: string;
	} = $props();

	let board = $state<WeaponBoardView | null>(null);
	let loading = $state(false);
	let seq = 0;
	$effect(() => {
		const q = query;
		const my = ++seq;
		loading = true;
		api<WeaponBoardView>(
			'GET',
			`/api/servers/${encodeURIComponent(serverId)}/leaderboard/weapons${qs(weaponQueryParams(q))}`
		)
			.then((r) => {
				if (my === seq) board = r;
			})
			.catch((err) => toast(errorMessage(err), 'err'))
			.finally(() => {
				if (my === seq) loading = false;
			});
	});

	const set = (patch: Partial<WeaponBoardQuery>) => onchange({ ...query, page: 1, ...patch });
	const weapons = knownCauses().filter((c) => causeKind(c.cause) === 'weapon');
	let pickValue = $derived(weaponPickParam(query.weapon));
	let pickLabel = $derived(
		query.weapon.kind === 'all'
			? 'every weapon'
			: query.weapon.kind === 'class'
				? (WEAPON_CLASSES.find((c) => c.key === (query.weapon as { key: string }).key)?.label ?? '')
				: query.weapon.kind === 'vehicleWeapons'
					? 'vehicle weapons'
					: query.weapon.kind === 'vehicles'
						? 'vehicles'
						: (board?.weapons.find(
								(w) => w.cause.toLowerCase() === (query.weapon as { cause: string }).cause.toLowerCase()
							)?.label ??
							knownCauses().find(
								(c) =>
									c.cause.toLowerCase() === (query.weapon as { cause: string }).cause.toLowerCase()
							)?.label ??
							(query.weapon as { cause: string }).cause)
	);
	let pages = $derived(board ? Math.max(1, Math.ceil(board.total / board.pageSize)) : 1);
	const pct = (hs: number, k: number) => (k > 0 ? `${Math.round((hs / k) * 100)}%` : '—');
	const metres = (m: number | null) => (m === null ? '—' : `${fmtNum(m)} m`);
	const SORTS: [WeaponSort, string][] = [
		['kills', 'Kills'],
		['headshots', 'Headshots'],
		['longest', 'Longest kill']
	];
</script>

<div class="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2">
	<div class="join">
		<button
			class="btn btn-sm {query.scope === 'server' ? 'btn-primary' : ''}"
			onclick={() => set({ scope: 'server' })}>This server</button
		>
		<button
			class="btn btn-sm {query.scope === 'org' ? 'btn-primary' : ''}"
			onclick={() => set({ scope: 'org' })}
			title={orgName ? `Every server of ${orgName}` : 'Every server of the organisation'}
			>Organisation</button
		>
	</div>
	<select
		class="input w-60"
		aria-label="Weapon"
		value={pickValue}
		onchange={(e) => set({ weapon: parseWeaponPick(e.currentTarget.value) })}
	>
		<option value="all">Every weapon</option>
		<optgroup label="Classes">
			{#each WEAPON_CLASSES as c (c.key)}<option value="class:{c.key}">{c.label}</option>{/each}
			<option value="vehicleWeapons">Vehicle weapons</option>
			<option value="vehicles">Vehicles (roadkills, crashes)</option>
		</optgroup>
		<optgroup label="Weapons">
			{#each weapons as w (w.cause)}<option value="cause:{w.cause}">{w.label}</option>{/each}
		</optgroup>
		{#if query.weapon.kind === 'cause' && !weapons.some((w) => w.cause.toLowerCase() === (query.weapon as { cause: string }).cause.toLowerCase())}
			<option value={pickValue}>{pickLabel}</option>
		{/if}
	</select>
	<div class="join">
		{#each SORTS as [key, label] (key)}
			<button
				class="btn btn-sm {query.sort === key ? 'btn-primary' : ''}"
				onclick={() => set({ sort: key })}>{label}</button
			>
		{/each}
	</div>
	{#if board}
		<div class="sm:ml-auto">
			<SeasonPicker
				when={board.when}
				seasons={board.seasons}
				{orgName}
				disabled={loading}
				onpick={(range) => set({ range })}
			/>
		</div>
	{/if}
</div>

<div class="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
	<div class="overflow-x-auto">
		<h3 class="mb-2 text-[13px] text-mist-400">Most kills with {pickLabel}</h3>
		<table class="table">
			<thead>
				<tr>
					<th class="num">#</th>
					<th>Player</th>
					<th class="num">Kills</th>
					<th class="num" title="Headshots">HS</th>
					<th class="num" title="Headshots per kill">HS%</th>
					<th class="num" title="The longest of these kills">Longest</th>
					<th>Most used</th>
				</tr>
			</thead>
			<tbody>
				{#each board?.rows ?? [] as r (r.steamId)}
					<tr>
						<td class="num text-mist-400">{r.rank}</td>
						<td
							><a
								href={hrefFor(r.steamId)}
								data-sveltekit-preload-data="tap"
								class="hover:text-accent hover:underline">{r.name}</a
							></td
						>
						<td class="num">{fmtNum(r.kills)}</td>
						<td class="num">{fmtNum(r.headshots)}</td>
						<td class="num">{pct(r.headshots, r.kills)}</td>
						<td class="num">{metres(r.longestM)}</td>
						<td class="text-mist-400">{r.topWeapon ?? '—'}</td>
					</tr>
				{:else}
					<tr>
						<td colspan="7" class="py-6 text-center text-mist-600">
							{#if !board || loading}Loading…{:else}No kills with {pickLabel} in this window.{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
		{#if board && pages > 1}
			<div class="mt-3 flex items-center gap-2 text-[12.5px] text-mist-400">
				<button
					class="btn btn-sm"
					disabled={query.page <= 1 || loading}
					onclick={() => onchange({ ...query, page: query.page - 1 })}>← Higher</button
				>
				<span>Page {query.page} of {pages}</span>
				<button
					class="btn btn-sm"
					disabled={query.page >= pages || loading}
					onclick={() => onchange({ ...query, page: query.page + 1 })}>Next →</button
				>
			</div>
		{/if}
	</div>
	<div class="overflow-x-auto">
		<h3 class="mb-2 text-[13px] text-mist-400">Weapons by kills</h3>
		<table class="table">
			<thead>
				<tr>
					<th>Weapon</th>
					<th class="num">Kills</th>
					<th class="num" title="Headshots per kill">HS%</th>
					<th class="num" title="The longest kill with it">Longest</th>
				</tr>
			</thead>
			<tbody>
				{#each board?.weapons ?? [] as w (w.cause)}
					<tr>
						<td
							><button
								type="button"
								class="text-left hover:text-accent hover:underline"
								onclick={() => set({ weapon: { kind: 'cause', cause: w.cause } })}>{w.label}</button
							></td
						>
						<td class="num">{fmtNum(w.kills)}</td>
						<td class="num">{pct(w.headshots, w.kills)}</td>
						<td class="num">{metres(w.longestM)}</td>
					</tr>
				{:else}
					<tr>
						<td colspan="4" class="py-6 text-center text-mist-600">
							{#if !board || loading}Loading…{:else}No kills in this window.{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</div>
<p class="note">
	From the kill feed: a kill of another side counts, suicides, team kills and the environment do not.
	Classes are the panel's own grouping of the game's weapons. A vehicle's weapons are its guns; a
	vehicle itself kills by running someone over or when it blows up.
</p>
