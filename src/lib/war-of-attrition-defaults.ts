// The War of Attrition rule's texts until an admin writes their own: the server validates against
// them (war-of-attrition.ts) and the Automation tab starts a new rule's editor with them.
// Client-safe.
export const WAR_OF_ATTRITION_DEFAULTS = {
	startMessage: 'War of attrition: the first side to lose {limit} lives loses the match!',
	milestoneMessage: '{faction} has lost {lost} of {limit} lives ({percent}%)! {standings}',
	winMessage: '{loser} has lost {limit} lives: {winner} wins the war of attrition! {standings}',
	timeWinMessage: 'Time is up: {winner} wins with the fewest lives lost! {standings}',
	drawMessage: 'The war of attrition is a draw. {standings}',
	timeLeftMessage: '{minutes} min left: {standings}'
};
