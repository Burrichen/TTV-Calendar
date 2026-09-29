/**
 * Runtime validation of Tennis TV payloads.
 *
 * Every field named here was observed on 2026-09-14 across 81 tournaments and 1868
 * matches (docs/TENNISTV_DATA_SOURCE.md). The schemas encode two judgements:
 *
 *  - **Required means "present in every record we have ever seen"**, and is what the
 *    provider genuinely cannot work without. `MatchId`, `MatchDate` and `PulseStatus`
 *    qualify; `Status` does not, because one record in 1868 lacked it.
 *  - **Unknown keys pass through.** Tennis TV adds fields without telling us, and a
 *    strict object would turn a harmless addition into an outage.
 */

import { z } from 'zod';

/** `YYYY-MM-DD`. */
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

/** Naive venue wall clock, no zone: `2026-08-24T11:00:00`. */
const naiveDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/, 'expected YYYY-MM-DDTHH:mm:ss with no zone');

/** Time of day with its own explicit offset, no date: `10:00+0800`. */
const offsetTimeOfDay = z.string().regex(/^\d{2}:\d{2}[+-]\d{4}$/, 'expected HH:mm+HHMM');

// ---------------------------------------------------------------- tournaments

const tournamentInfoSchema = z
  .object({
    title: z.string().optional(),
    city: z.string().nullish(),
    /**
     * Venue offset in decimal hours (`-4`, `8`, `5.5`). Missing on 1 of 81
     * tournaments, which is why the mapper must treat its absence as "time unknown".
     */
    utcOffset: z.number().nullish(),
    mainStart: isoDate.optional(),
    qualStart: isoDate.optional(),
    inOutdoor: z.string().optional(),
  })
  .loose();

const tournamentMetadataSchema = z
  .object({
    /** Present on only 6 of 81 tournaments. Absence means shown. */
    notShown: z.boolean().optional(),
    broadcastText: z.string().optional(),
    /** Path on tennistv.com, e.g. `/tournaments/hangzhou-open`. */
    customRoute: z.string().optional(),
    /** A FORECAST of the event's size, never a count of published matches. */
    matchesSize: z.string().optional(),
  })
  .loose();

const availableOopDaySchema = z
  .object({
    isoDate: isoDate.optional(),
    dateSeq: z.number().optional(),
    qualifying: z.boolean().optional(),
  })
  .loose();

export const rawTournamentSchema = z
  .object({
    id: z.number(),
    year: z.number().int(),
    name: z.string(),
    gender: z.string().optional(),
    start: isoDate,
    end: isoDate,
    qualificationStart: isoDate.optional(),
    type: z.string().optional(),
    /** Country or region. Missing on 1 of 81. */
    location: z.string().nullish(),
    surface: z.string().nullish(),
    info: tournamentInfoSchema.optional(),
    /** Absent entirely on 20 of 81 tournaments. */
    metadata: tournamentMetadataSchema.optional(),
    /** The signal that match-level data exists (TENNISTV_DATA_SOURCE.md §7). */
    availableOopDays: z.array(availableOopDaySchema).nullish(),
  })
  .loose();

export type RawTournament = z.infer<typeof rawTournamentSchema>;

export const rawTournamentListSchema = z.array(z.unknown());

// -------------------------------------------------------------------- matches

const playerTeamSchema = z
  .object({
    PlayerId: z.string().nullish(),
    PlayerFirstName: z.string().nullish(),
    PlayerFirstNameFull: z.string().nullish(),
    PlayerLastName: z.string().nullish(),
    PlayerCountryCode: z.string().nullish(),
    PartnerId: z.string().nullish(),
    PartnerFirstName: z.string().nullish(),
    PartnerLastName: z.string().nullish(),
  })
  .loose();

const teamPlayerSchema = z
  .object({
    PlayerId: z.string().nullish(),
    FirstName: z.string().nullish(),
    LastName: z.string().nullish(),
    Country: z.string().nullish(),
    OrderInTeam: z.number().nullish(),
  })
  .loose();

const teamInMatchSchema = z
  .object({
    TeamNumber: z.number().nullish(),
    TeamCode: z.string().nullish(),
    Players: z.array(teamPlayerSchema).nullish(),
    /** False when the provider is holding a slot for an undecided opponent. */
    IsKnown: z.boolean().nullish(),
  })
  .loose();

const roundSchema = z
  .object({
    ShortName: z.string().nullish(),
    LongName: z.string().nullish(),
    RoundName: z.string().nullish(),
    RoundId: z.number().nullish(),
  })
  .loose();

const matchMetadataSchema = z
  .object({
    /** Never observed at match level, but honoured if it ever appears. */
    notShown: z.boolean().optional(),
    description: z.string().optional(),
  })
  .loose();

export const rawMatchSchema = z
  .object({
    MatchId: z.string().min(1),
    /** Venue-local; a `T00:00:00` time means the start is not published. */
    MatchDate: naiveDateTime,
    /** `U` order-of-play, `L` live, `C` completed representation. */
    PulseStatus: z.string().min(1),
    /** The truthful state field — but absent on 1 of 1868 records. */
    Status: z.string().nullish(),
    Reason: z.string().nullish(),
    NotBeforeISOTime: offsetTimeOfDay.nullish(),
    /** `Starts At` | `Not Before` | `Followed By`. */
    NotBeforeText: z.string().nullish(),
    NotBefore: z.string().nullish(),
    TournamentId: z.number(),
    TournamentYear: z.number().int(),
    CourtName: z.string().nullish(),
    Round: roundSchema.nullish(),
    /** Result-record competitor shape. */
    PlayerTeam1: playerTeamSchema.nullish(),
    PlayerTeam2: playerTeamSchema.nullish(),
    /** Order-of-play competitor shape. */
    TeamsInMatch: z.array(teamInMatchSchema).nullish(),
    metadata: matchMetadataSchema.nullish(),
  })
  .loose();

export type RawMatch = z.infer<typeof rawMatchSchema>;

/** `/matches` returns an envelope, not a bare array. */
export const rawMatchesEnvelopeSchema = z
  .object({
    matches: z.array(z.unknown()).nullish(),
    tournaments: z.array(z.unknown()).nullish(),
  })
  .loose();

// ------------------------------------------------------------ error envelope

/** What the API returns on a bad request, e.g. `size` above 250. */
export const apiErrorSchema = z
  .object({
    error: z.string().optional(),
    message: z.string().optional(),
    status: z.number().optional(),
  })
  .loose();
