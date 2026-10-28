// The Kill race rule's texts until an admin writes their own: the server validates against them
// (kill-race.ts) and the Automation tab starts a new rule's editor with them. Client-safe.
export const KILL_RACE_DEFAULTS = {
	startMessage: 'Kill race: the first side to {target} kills wins!',
	progressMessage: '{standings} · first to {target} wins',
	winMessage: '{winner} wins the kill race with {kills} kills! Top killer: {top}.',
	drawMessage: 'Time is up: the kill race is a draw at {kills} kills.',
	timeLeftMessage: '{minutes} min left: {standings}'
};
