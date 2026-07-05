import { describe, expect, test } from 'bun:test';

import type { MessageInRow } from '../db/messages-in.js';
import { bookingIntent, parseSlotsResponse } from './availability.js';

const row = (text: string, sender = 'Web customer'): MessageInRow =>
  ({ content: JSON.stringify({ text, sender }) }) as MessageInRow;

describe('bookingIntent', () => {
  test('booking phrases trigger', () => {
    expect(bookingIntent([row('ok confirm, when can you come?')])).toBe(true);
    expect(bookingIntent([row('what time slots do you have')])).toBe(true);
    expect(bookingIntent([row('book me in for saturday')])).toBe(true);
  });
  test('non-booking chatter does not', () => {
    expect(bookingIntent([row('my aircon is leaking, how much?')])).toBe(false);
    expect(bookingIntent([row('can i get a discount')])).toBe(false);
  });
  test('system notices ignored', () => {
    expect(bookingIntent([row('Owner approved quote — schedule it', 'system')])).toBe(false);
  });
});

describe('parseSlotsResponse', () => {
  test('v2 shape with {start} objects', () => {
    const days = parseSlotsResponse(
      { data: { '2026-07-07': [{ start: '2026-07-07T02:00:00.000Z' }, { start: '2026-07-07T05:00:00.000Z' }] } },
      'Asia/Singapore',
    );
    expect(days).toHaveLength(1);
    expect(days[0].times).toEqual(['10:00', '13:00']);
  });
  test('plain string slots + nested slots key tolerated', () => {
    const days = parseSlotsResponse(
      { data: { slots: { '2026-07-08': ['2026-07-08T01:00:00.000Z'] } } },
      'Asia/Singapore',
    );
    expect(days[0].times).toEqual(['09:00']);
  });
  test('garbage → empty', () => {
    expect(parseSlotsResponse(null, 'Asia/Singapore')).toEqual([]);
    expect(parseSlotsResponse({ data: 'nope' }, 'Asia/Singapore')).toEqual([]);
  });
});
