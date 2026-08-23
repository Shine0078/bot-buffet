import type { Schedule } from './types.js';

const FIELD = /^(\*|\d+|\d+-\d+|\*\/\d+|\d+(,\d+)*)$/;
const RANGES: Array<readonly [number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 6],
];

export function parseCron(cron: string): string[] {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('schedule_cron_invalid');
  for (const [index, field] of fields.entries()) {
    if (!FIELD.test(field)) throw new Error('schedule_cron_invalid');
    const [min, max] = RANGES[index]!;
    for (const part of field.split(',')) {
      if (part === '*') continue;
      if (part.startsWith('*/')) {
        const step = Number(part.slice(2));
        if (!Number.isInteger(step) || step < 1) throw new Error('schedule_cron_invalid');
        continue;
      }
      const [startRaw, endRaw] = part.split('-');
      const start = Number(startRaw);
      const end = endRaw === undefined ? start : Number(endRaw);
      if (
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < min ||
        end > max ||
        start > end
      ) {
        throw new Error('schedule_cron_invalid');
      }
    }
  }
  return fields;
}

const matchesField = (field: string, value: number, min: number, max: number): boolean => {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = Number(field.slice(2));
    return (value - min) % step === 0;
  }
  return field.split(',').some((part) => {
    const [startRaw, endRaw] = part.split('-');
    const start = Number(startRaw);
    const end = endRaw === undefined ? start : Number(endRaw);
    return value >= start && value <= end && start >= min && end <= max;
  });
};

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export function assertTimezone(timezone: string): string {
  const zone = timezone.trim() || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(new Date(0));
  } catch {
    throw new Error('schedule_timezone_invalid');
  }
  return zone;
}

export function zonedParts(
  at: Date,
  timezone = 'UTC',
): {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
} {
  const zone = assertTimezone(timezone);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    weekday: 'short',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '';
  const weekday = WEEKDAYS[read('weekday')];
  if (weekday === undefined) throw new Error('schedule_timezone_unparsed');
  return {
    minute: Number(read('minute')),
    hour: Number(read('hour')),
    day: Number(read('day')),
    month: Number(read('month')),
    weekday,
  };
}

export function cronMatches(cron: string, at: Date, timezone = 'UTC'): boolean {
  const [minute, hour, day, month, weekday] = parseCron(cron);
  const parts = zonedParts(at, timezone);
  return (
    matchesField(minute!, parts.minute, 0, 59) &&
    matchesField(hour!, parts.hour, 0, 23) &&
    matchesField(day!, parts.day, 1, 31) &&
    matchesField(month!, parts.month, 1, 12) &&
    matchesField(weekday!, parts.weekday, 0, 6)
  );
}

export function dueSchedules(schedules: readonly Schedule[], at: Date): Schedule[] {
  return schedules.filter((schedule) => {
    if (!schedule.enabled) return false;
    try {
      return cronMatches(schedule.cron, at, schedule.timezone);
    } catch {
      return false;
    }
  });
}
