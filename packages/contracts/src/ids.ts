import { z } from 'zod';

/** Decimal string of a Telegram numeric user id. Never a JS number (precision) and never a username. */
export const TelegramUserIdSchema = z.string().regex(/^[1-9][0-9]{0,18}$/, 'must be a positive decimal Telegram numeric id');
export type TelegramUserId = z.infer<typeof TelegramUserIdSchema>;

export const UuidSchema = z.uuid();
export type UUID = z.infer<typeof UuidSchema>;

export const IsoInstantSchema = z.iso.datetime({ offset: true });
