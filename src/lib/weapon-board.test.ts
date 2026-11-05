import { describe, expect, test } from 'bun:test';
import {
	parseWeaponPick,
	parseWeaponQuery,
	weaponPickParam,
	weaponQueryParams
} from './weapon-board';

describe('the weapon boards’ query', () => {
	test('a pick read back: every weapon, a class, the vehicles, one weapon; anything else is every weapon', () => {
		expect(parseWeaponPick(null)).toEqual({ kind: 'all' });
		expect(parseWeaponPick('class:sniper')).toEqual({ kind: 'class', key: 'sniper' });
		expect(parseWeaponPick('class:nope')).toEqual({ kind: 'all' });
		expect(parseWeaponPick('vehicles')).toEqual({ kind: 'vehicles' });
		expect(parseWeaponPick('cause:Id.Item.Mosin')).toEqual({
			kind: 'cause',
			cause: 'Id.Item.Mosin'
		});
		expect(parseWeaponPick('cause:not a tag')).toEqual({ kind: 'all' });
		for (const v of ['all', 'class:pistol', 'vehicleWeapons', 'cause:Id.Item.SV98'])
			expect(weaponPickParam(parseWeaponPick(v))).toBe(v);
	});
	test('the query as parameters and back, defaults left out', () => {
		const q = parseWeaponQuery(
			new URLSearchParams('scope=org&range=30d&weapon=class:smg&wsort=longest&page=2')
		);
		expect(q).toEqual({
			scope: 'org',
			range: '30d',
			weapon: { kind: 'class', key: 'smg' },
			sort: 'longest',
			page: 2
		});
		expect(weaponQueryParams(q)).toEqual({
			scope: 'org',
			range: '30d',
			weapon: 'class:smg',
			wsort: 'longest',
			page: '2'
		});
		expect(weaponQueryParams(parseWeaponQuery(new URLSearchParams()))).toEqual({});
	});
});
