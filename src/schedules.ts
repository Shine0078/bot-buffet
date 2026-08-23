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

export function cronMatches(cron: string, at: Date): boolean {
  const [minute, hour, day, month, weekday] = parseCron(cron);
  return (
    matchesField(minute!, at.getUTCMinutes(), 0, 59) &&
    matchesField(hour!, at.getUTCHours(), 0, 23) &&
    matchesField(day!, at.getUTCDate(), 1, 31) &&
    matchesField(month!, at.getUTCMonth() + 1, 1, 12) &&
    matchesField(weekday!, at.getUTCDay(), 0, 6)
  );
}

export function dueSchedules(schedules: readonly Schedule[], at: Date): Schedule[] {
  return schedules.filter((schedule) => schedule.enabled && cronMatches(schedule.cron, at));
}
