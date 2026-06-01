export const CHECKIN_RANDOM_WINDOW_LABEL = '08:00-22:30';

export const CHECKIN_SCHEDULE_MODES = ['cron', 'interval', 'random'] as const;

export type CheckinScheduleMode = typeof CHECKIN_SCHEDULE_MODES[number];

export function isCheckinScheduleMode(value: unknown): value is CheckinScheduleMode {
  return typeof value === 'string' && CHECKIN_SCHEDULE_MODES.includes(value as CheckinScheduleMode);
}
