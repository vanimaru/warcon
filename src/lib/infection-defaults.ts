// The Infection rule's texts until an admin writes their own: the server validates against them
// (infection.ts) and the Automation tab starts a new rule's editor with them. Client-safe.
export const INFECTION_DEFAULTS = {
	startMessage: 'Infection! {patients} carry the infection. Survivors, hold out!',
	infectWhisper: 'You were infected by {killer}. You now fight for {team}.',
	infectBroadcast: '',
	lastSurvivorMessage: '{name} is the last survivor!',
	allInfectedMessage: 'Everyone is infected. The infection wins this round.'
};
