import { describe, expect, test } from 'bun:test';

import type { MessageInRow } from '../db/messages-in.js';
import { collectImagePaths } from './vision.js';

function row(content: unknown): MessageInRow {
  return { content: JSON.stringify(content) } as MessageInRow;
}

describe('collectImagePaths', () => {
  test('picks image attachments by extension', () => {
    const batch = [
      row({ text: 'leaky unit', attachments: [{ localPath: 'inbox/m1/photo.jpg' }] }),
      row({ text: 'and this', attachments: [{ localPath: 'inbox/m2/unit.png' }] }),
    ];
    expect(collectImagePaths(batch)).toEqual(['inbox/m1/photo.jpg', 'inbox/m2/unit.png']);
  });

  test('ignores non-image attachments and malformed content', () => {
    const batch = [
      row({ attachments: [{ localPath: 'inbox/m1/voice.ogg' }, { localPath: 'inbox/m1/doc.pdf' }] }),
      { content: 'not json' } as MessageInRow,
      row({ text: 'no attachments' }),
    ];
    expect(collectImagePaths(batch)).toEqual([]);
  });

  test('caps at 2 images', () => {
    const batch = [
      row({ attachments: [1, 2, 3, 4].map((i) => ({ localPath: `inbox/m/${i}.jpg` })) }),
    ];
    expect(collectImagePaths(batch)).toHaveLength(2);
  });
});
