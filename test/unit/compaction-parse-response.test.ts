/**
 * Unit tests for parseCompactionResponse.
 *
 * Covers extraction of `<compacted_entry>` blocks, XML entity unescaping,
 * whitespace-only block skipping, empty/no-match inputs, and malformed tags.
 *
 * @see .kiro/specs/buffer-compaction-worker/design.md § Function 5
 * @see .kiro/specs/buffer-compaction-worker/requirements.md § Requirements 10.1, 10.2, 10.3, 10.4
 */

import { describe, expect, it } from 'vitest';

import { parseCompactionResponse } from '../../src/collector/buffer/compaction.js';

describe('parseCompactionResponse', () => {
  describe('extraction of <compacted_entry> blocks (Req 10.1)', () => {
    it('extracts a single block', () => {
      const xml = '<compacted_entry>User created a new project</compacted_entry>';
      const result = parseCompactionResponse(xml);
      expect(result).toEqual(['User created a new project']);
    });

    it('extracts multiple blocks in order', () => {
      const xml = [
        '<compacted_entry>First summary</compacted_entry>',
        '<compacted_entry>Second summary</compacted_entry>',
        '<compacted_entry>Third summary</compacted_entry>',
      ].join('\n');

      const result = parseCompactionResponse(xml);
      expect(result).toEqual(['First summary', 'Second summary', 'Third summary']);
    });

    it('extracts blocks with surrounding text', () => {
      const xml =
        'Some preamble text\n' +
        '<compacted_entry>Summary A</compacted_entry>\n' +
        'Interstitial text\n' +
        '<compacted_entry>Summary B</compacted_entry>\n' +
        'Trailing text';

      const result = parseCompactionResponse(xml);
      expect(result).toEqual(['Summary A', 'Summary B']);
    });

    it('trims leading and trailing whitespace from block content', () => {
      const xml = '<compacted_entry>  trimmed content  </compacted_entry>';
      const result = parseCompactionResponse(xml);
      expect(result).toEqual(['trimmed content']);
    });
  });

  describe('XML entity unescaping (Req 10.2)', () => {
    it('unescapes &amp; to &', () => {
      const xml = '<compacted_entry>A &amp; B</compacted_entry>';
      expect(parseCompactionResponse(xml)).toEqual(['A & B']);
    });

    it('unescapes &lt; to <', () => {
      const xml = '<compacted_entry>a &lt; b</compacted_entry>';
      expect(parseCompactionResponse(xml)).toEqual(['a < b']);
    });

    it('unescapes &gt; to >', () => {
      const xml = '<compacted_entry>a &gt; b</compacted_entry>';
      expect(parseCompactionResponse(xml)).toEqual(['a > b']);
    });

    it('unescapes &quot; to "', () => {
      const xml = '<compacted_entry>say &quot;hello&quot;</compacted_entry>';
      expect(parseCompactionResponse(xml)).toEqual(['say "hello"']);
    });

    it('unescapes &apos; to \'', () => {
      const xml = "<compacted_entry>it&apos;s fine</compacted_entry>";
      expect(parseCompactionResponse(xml)).toEqual(["it's fine"]);
    });

    it('unescapes all five entities in a single block', () => {
      const xml =
        '<compacted_entry>&amp; &lt; &gt; &quot; &apos;</compacted_entry>';
      expect(parseCompactionResponse(xml)).toEqual(['& < > " \'']);
    });

    it('handles double-escaped &amp;lt; correctly (unescapes &amp; last)', () => {
      // The string "&amp;lt;" should become "&lt;" — not "<"
      const xml = '<compacted_entry>&amp;lt;</compacted_entry>';
      expect(parseCompactionResponse(xml)).toEqual(['&lt;']);
    });
  });

  describe('whitespace-only block skipping (Req 10.3)', () => {
    it('skips blocks with only spaces', () => {
      const xml = '<compacted_entry>   </compacted_entry>';
      expect(parseCompactionResponse(xml)).toEqual([]);
    });

    it('skips blocks with only newlines and tabs', () => {
      const xml = '<compacted_entry>\n\t\n</compacted_entry>';
      expect(parseCompactionResponse(xml)).toEqual([]);
    });

    it('skips empty blocks', () => {
      const xml = '<compacted_entry></compacted_entry>';
      expect(parseCompactionResponse(xml)).toEqual([]);
    });

    it('skips whitespace-only blocks but keeps non-empty blocks', () => {
      const xml = [
        '<compacted_entry>  </compacted_entry>',
        '<compacted_entry>valid content</compacted_entry>',
        '<compacted_entry>\n</compacted_entry>',
      ].join('');

      expect(parseCompactionResponse(xml)).toEqual(['valid content']);
    });
  });

  describe('empty and no-match inputs (Req 10.4)', () => {
    it('returns empty array for empty string', () => {
      expect(parseCompactionResponse('')).toEqual([]);
    });

    it('returns empty array for input with no <compacted_entry> blocks', () => {
      const text = 'Here is some plain text with no XML tags at all.';
      expect(parseCompactionResponse(text)).toEqual([]);
    });

    it('returns empty array for input with unrelated XML tags', () => {
      const text = '<memory_record>some content</memory_record>';
      expect(parseCompactionResponse(text)).toEqual([]);
    });
  });

  describe('malformed/unclosed tags', () => {
    it('ignores unclosed <compacted_entry> tag', () => {
      const xml = '<compacted_entry>no closing tag';
      expect(parseCompactionResponse(xml)).toEqual([]);
    });

    it('ignores closing tag without opening tag', () => {
      const xml = 'orphan content</compacted_entry>';
      expect(parseCompactionResponse(xml)).toEqual([]);
    });

    it('extracts valid blocks even when preceded by unclosed tags', () => {
      // The non-greedy regex matches from the second <compacted_entry> to
      // the next </compacted_entry>, so the unclosed tag's content bleeds
      // into the next match. This is expected regex-based behavior.
      const xml = [
        '<compacted_entry>valid block</compacted_entry>',
        'some unclosed <compacted_entry> tag without closing',
        '<compacted_entry>another valid</compacted_entry>',
      ].join('\n');

      const result = parseCompactionResponse(xml);
      // First block is extracted cleanly
      expect(result[0]).toBe('valid block');
      // The parser still finds the second closing tag
      expect(result.length).toBeGreaterThanOrEqual(2);
      expect(result[result.length - 1]).toContain('another valid');
    });

    it('returns empty array when only unclosed tags exist', () => {
      const xml = '<compacted_entry>no closing tag at all';
      expect(parseCompactionResponse(xml)).toEqual([]);
    });
  });
});
