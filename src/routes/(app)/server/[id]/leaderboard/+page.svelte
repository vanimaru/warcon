<script lang="ts">
	// The Leaderboards tab: one board over this server or the organisation, read once per
	// change of the controls (no polling: it is history, not a live view). The URL follows the
	// query so a board can be linked.
	import { page } from '$app/state';
	import { replaceState } from '$app/navigation';
	import { api, errorMessage, qs } from '$lib/api';
	import { toast } from '$lib/toast.svelte';
	import LeaderboardTable from '$lib/components/LeaderboardTable.svelte';
	import WeaponBoard from '$lib/components/WeaponBoard.svelte';
	import { parseWeaponQuery, weaponQueryParams, type WeaponBoardQuery } from '$lib/weapon-board';
	import {
		boardQueryParams,
		parseBoardQuery,
		type BoardQuery,
		type BoardView
	} from '$lib/leaderboard';
	import { effectiveFeatures } from '$lib/features';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let id = $derived(data.server.id);
	let query = $state<BoardQuery>(parseBoardQuery(page.url.searchParams));
	/** the players' board, or the weapons' (`?view=weapons`) */
	let view = $state<'players' | 'weapons'>(
		page.url.searchParams.get('view') === 'weapons' ? 'weapons' : 'players'
	);
	let weaponQuery = $state<WeaponBoardQuery>(parseWeaponQuery(page.url.searchParams));
	let board = $state<BoardView | null>(null);
	let loading = $state(false);
	let seq = 0;
	let publicOn = $derived(effectiveFeatures(data.server, data.server).leaderboards);
	/** the whole board as it is set, from the top */
	let exportHref = $derived(
		`/api/servers/${encodeURIComponent(id)}/leaderboard/export${qs(boardQueryParams({ ...query, page: 1 }))}`
	);

	async function load(q: BoardQuery) {
		const my = ++seq;
		loading = true;
		try {
			const r = await api<BoardView>(
				'GET',
				`/api/servers/${encodeURIComponent(id)}/leaderboard${qs(boardQueryParams(q))}`
			);
			if (my !== seq) return;
			board = r;
		} catch (err) {
			toast(errorMessage(err), 'err');
		} finally {
			if (my === seq) loading = false;
		}
	}
	$effect(() => {
		if (view !== 'players') return;
		const q = query;
		const url = new URL(page.url);
		url.search = qs(boardQueryParams(q));
		if (url.search !== page.url.search) replaceState(url, {});
		void load(q);
	});
	$effect(() => {
		if (view !== 'weapons') return;
		const url = new URL(page.url);
		url.search = qs({ view: 'weapons', ...weaponQueryParams(weaponQuery) });
		if (url.search !== page.url.search) replaceState(url, {});
	});
</script>

<div class="panel">
	<div class="join mb-3">
		<button
			class="btn btn-sm {view === 'players' ? 'btn-primary' : ''}"
			onclick={() => (view = 'players')}>Players</button
		>
		<button
			class="btn btn-sm {view === 'weapons' ? 'btn-primary' : ''}"
			onclick={() => (view = 'weapons')}>Weapons</button
		>
	</div>
	{#if view === 'weapons'}
		<WeaponBoard
			serverId={id}
			query={weaponQuery}
			onchange={(q) => (weaponQuery = q)}
			hrefFor={(steamId) => `/server/${encodeURIComponent(id)}/players/${steamId}`}
			orgName={data.server.orgName}
		/>
	{:else}
	<LeaderboardTable
		{board}
		{query}
		{loading}
		onchange={(q) => (query = q)}
		hrefFor={(steamId) => `/server/${encodeURIComponent(id)}/players/${steamId}`}
		orgName={data.server.orgName}
		showIds
		{exportHref}
	/>
	<p class="note">
		Kills and deaths are the game's own scoreboard counters, recorded per match; headshots, team
		kills and streaks come from the kill feed; playtime and cash from player sessions, cash added up
		match by match. A match counts once it has ended, with the result read against the side the
		player played. Kills per hour and cash per minute leave seed time out. Names link to the
		dossier.
		{#if publicOn}This board is also public at <a
				href="/s/{encodeURIComponent(id)}/leaderboard"
				class="text-accent hover:underline">/s/{id}/leaderboard</a
			>.{/if}
	</p>
	{/if}
</div>
