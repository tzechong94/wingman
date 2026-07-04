import { describe, expect, test } from 'bun:test';

import { sanitizeNarratedToolTags } from './sanitize.js';

describe('sanitizeNarratedToolTags', () => {
  test('converts narrated ask_user_question into plain text', () => {
    const input =
      'Hello!\n<ask_user_question>\n{"questions": [{"question": "How many units are leaking?", "options": ["1", "2", "3+"]}]}\n</ask_user_question>';
    const out = sanitizeNarratedToolTags(input);
    expect(out).toContain('How many units are leaking? (1 / 2 / 3+)');
    expect(out).not.toContain('<ask_user_question>');
    expect(out).not.toContain('{');
  });

  test('handles truncated (unterminated) blocks', () => {
    const input = '<ask_user_question>\n{"questions": [{"question": "Wall-mounted or ceiling cassette?"';
    const out = sanitizeNarratedToolTags(input);
    expect(out).toContain('Wall-mounted or ceiling cassette?');
    expect(out).not.toContain('<ask_user_question>');
  });

  test('unparseable narration degrades to readable text', () => {
    const out = sanitizeNarratedToolTags('<ask_user_question>tell me your unit type</ask_user_question>');
    expect(out).toBe('tell me your unit type');
  });

  test('normal text passes through untouched', () => {
    const s = '<message to="cust">How many units?</message>';
    expect(sanitizeNarratedToolTags(s)).toBe(s);
  });
});
