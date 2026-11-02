// The Economic War rule's texts until an admin writes their own: the server validates against them
// (economic-war.ts) and the Automation tab starts a new rule's editor with them. Client-safe.
export const ECONOMIC_WAR_DEFAULTS = {
	startMessage: 'Economic War: the first side to earn {target} wins!',
	progressMessage: '{standings} · first to {target} wins',
	winMessage: '{winner} wins the Economic War with {cash} earned! Top earner: {top}.',
	drawMessage: 'Time is up: the Economic War is a draw at {cash}.',
	timeLeftMessage: '{minutes} min left: {standings}'
};
