import { z } from 'zod';

export const ApiErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export interface ApiOk<T> {
  requestId: string;
  data: T;
}
export interface ApiFail {
  requestId: string;
  error: ApiError;
}

export const CreateTaskBodySchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().max(4000).optional(),
  priority: z.number().int().min(0).max(3).optional(),
  dueAt: z.iso.datetime({ offset: true }).optional(),
});
export type CreateTaskBody = z.infer<typeof CreateTaskBodySchema>;

export const UpdateTaskBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  title: z.string().min(1).max(300).optional(),
  description: z.string().max(4000).nullable().optional(),
  priority: z.number().int().min(0).max(3).optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  status: z.enum(['open', 'in_progress', 'done', 'cancelled']).optional(),
});
export type UpdateTaskBody = z.infer<typeof UpdateTaskBodySchema>;

export const CreateReminderBodySchema = z.object({
  taskId: z.uuid().optional(),
  title: z.string().min(1).max(300),
  /** Local wall-clock time, e.g. 2026-10-16T09:00 (no offset). Interpreted in `timezone`. */
  localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  timezone: z.string().min(1).max(64).optional(),
  recurrence: z
    .object({
      freq: z.enum(['daily', 'weekly', 'monthly']),
      interval: z.number().int().min(1).max(366).default(1),
      byWeekday: z.array(z.number().int().min(1).max(7)).max(7).optional(),
    })
    .optional(),
  mode: z.enum(['message', 'call']).default('message'),
});
export type CreateReminderBody = z.infer<typeof CreateReminderBodySchema>;

export const RescheduleReminderBodySchema = z.object({
  expectedVersion: z.number().int().min(1),
  localDateTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
  timezone: z.string().min(1).max(64).optional(),
});
export type RescheduleReminderBody = z.infer<typeof RescheduleReminderBodySchema>;
