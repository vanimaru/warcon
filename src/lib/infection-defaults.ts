// The Infection rule's texts until an admin writes their own: the server validates against them
// (infection.ts) and the Automation tab starts a new rule's editor with them. Client-safe.
export const INFECTION_DEFAULTS = {
	startMessage: 'Infection! {patients} carry the infection. Survivors, hold out!',
	patientWhisper:
		'You were picked to carry the infection: you now fight for {team}. Infect the survivors!',
	infectWhisper: 'You were infected by {killer}. You now fight for {team}.',
	infectBroadcast: '',
	fewLeftMessage: 'Only {survivors} survivors left!',
	lastSurvivorMessage: '{name} is the last survivor!',
	allInfectedMessage: 'Everyone is infected!',
	survivorsWinMessage:
		'The survivors held out with {survivors} still uninfected. Top infector: {top}.',
	infectedWinMessage: 'The infection wins with {infected} infected. Top infector: {top}.',
	timeLeftMessage: '{minutes} min left: {survivors} survivors still standing!'
};
