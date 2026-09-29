/**
 * The single implementation of "is this available on Tennis TV".
 *
 * PROJECT_SPEC.md §9: exclude what is explicitly marked unavailable; do NOT require a
 * positive marker. Reconnaissance confirmed this is the only rule that works — the
 * marker appears on 6 of 81 tournaments, and 20 carry no metadata at all
 * (TENNISTV_DATA_SOURCE.md §8).
 *
 * Every filter in the application routes through here so the rule exists once.
 */

import type { Match, Tournament } from './types.ts';

export const isTournamentAvailable = (tournament: Tournament): boolean =>
  tournament.isShownOnTennisTv;

export const isMatchAvailable = (match: Match): boolean => match.isShownOnTennisTv;

export const availableTournaments = (tournaments: readonly Tournament[]): Tournament[] =>
  tournaments.filter(isTournamentAvailable);

export const availableMatches = (matches: readonly Match[]): Match[] =>
  matches.filter(isMatchAvailable);
