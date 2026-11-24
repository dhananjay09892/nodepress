import { describe, expect, it } from 'vitest';
import {
  DailySalt,
  dayOf,
  hashVisitor,
  isBot,
  normalizePath,
  optedOut,
  parseDay,
  readRetentionDays,
  referrerHost,
  shiftDay,
} from './analytics.js';
import { beaconHtml, SCRIPT } from './index.js';

describe('who is counted', () => {
  it('skips Do Not Track and Global Privacy Control', () => {
    expect(optedOut({ dnt: '1' })).toBe(true);
    expect(optedOut({ 'sec-gpc': '1' })).toBe(true);
    expect(optedOut({ dnt: '0' })).toBe(false);
    expect(optedOut({})).toBe(false);
  });

  it('recognises crawlers, monitors and empty user agents as bots', () => {
    for (const agent of [
      '',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; bingbot/2.0)',
      'curl/8.5.0',
      'UptimeRobot/2.0',
      'python-requests/2.32',
      'Slackbot-LinkExpanding 1.0',
      'Mozilla/5.0 Chrome-Lighthouse',
    ]) {
      expect(isBot(agent), agent).toBe(true);
    }
    expect(isBot(undefined)).toBe(true);
  });

  it('counts ordinary browsers, including headless Chrome used by end-to-end tests', () => {
    for (const agent of [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0 Safari/537.36',
    ]) {
      expect(isBot(agent), agent).toBe(false);
    }
  });
});

describe('visitor hashes and the daily salt', () => {
  const counter = () => {
    let n = 0;
    return () => Buffer.from(`salt-${++n}`);
  };

  it('keeps one salt for a day and replaces it on the next', () => {
    const salt = new DailySalt(counter());
    const first = salt.forDay('2026-11-24');
    expect(salt.forDay('2026-11-24')).toBe(first);
    const second = salt.forDay('2026-11-25');
    expect(second.equals(first)).toBe(false);
    expect(salt.day).toBe('2026-11-25');
  });

  it('never gives yesterday’s salt back, so yesterday’s hashes cannot be reproduced', () => {
    const salt = new DailySalt(counter());
    const monday = hashVisitor(salt.forDay('2026-11-23'), '203.0.113.7', 'Browser/1');
    const tuesday = hashVisitor(salt.forDay('2026-11-24'), '203.0.113.7', 'Browser/1');
    expect(tuesday).not.toBe(monday);
    // Going back to monday draws a fresh salt, not the old one.
    expect(hashVisitor(salt.forDay('2026-11-23'), '203.0.113.7', 'Browser/1')).not.toBe(monday);
  });

  it('gives the same visitor the same hash within a day and different ones to different visitors', () => {
    const salt = Buffer.from('s');
    const a = hashVisitor(salt, '203.0.113.7', 'Browser/1');
    expect(hashVisitor(salt, '203.0.113.7', 'Browser/1')).toBe(a);
    expect(hashVisitor(salt, '203.0.113.8', 'Browser/1')).not.toBe(a);
    expect(hashVisitor(salt, '203.0.113.7', 'Browser/2')).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain('203');
  });
});

describe('paths and referrers', () => {
  it('normalizes a path: no query, fragment or trailing slash', () => {
    expect(normalizePath('/blog/hello/?utm=1#top')).toBe('/blog/hello');
    expect(normalizePath('/')).toBe('/');
    expect(normalizePath('/about///')).toBe('/about');
  });

  it('refuses things that are not pages of this site', () => {
    for (const value of [
      undefined,
      42,
      '',
      'https://evil.example/x',
      '//evil.example/x',
      'relative',
      '/a\nb',
      '/a\\b',
      '/api/v1/posts',
      '/admin',
      '/admin/posts',
      `/${'x'.repeat(200)}`,
    ]) {
      expect(normalizePath(value), String(value)).toBeUndefined();
    }
    expect(normalizePath('/apiary')).toBe('/apiary');
  });

  it('keeps only the host of an outside referrer', () => {
    expect(referrerHost('https://www.News.example.com/story?id=1', 'blog.test')).toBe(
      'news.example.com',
    );
    expect(referrerHost('https://blog.test/other', 'blog.test:3000')).toBe('');
    expect(referrerHost('https://www.blog.test/', 'blog.test')).toBe('');
    expect(referrerHost('android-app://com.google.android.gm', 'blog.test')).toBe('');
    expect(referrerHost('not a url', 'blog.test')).toBe('');
    expect(referrerHost(undefined, 'blog.test')).toBe('');
  });
});

describe('dates and settings', () => {
  it('works in UTC days', () => {
    expect(dayOf(new Date('2026-11-24T23:59:59Z'))).toBe('2026-11-24');
    expect(shiftDay('2026-03-01', 1)).toBe('2026-02-28');
    expect(shiftDay('2026-11-24', -1)).toBe('2026-11-25');
  });

  it('accepts real calendar days only', () => {
    expect(parseDay('2026-11-24')).toBe('2026-11-24');
    for (const value of ['2026-02-30', '2026-13-01', '24-11-2026', '2026-1-1', 5, undefined]) {
      expect(parseDay(value), String(value)).toBeUndefined();
    }
  });

  it('defaults the retention to 90 days and clamps it', () => {
    expect(readRetentionDays(undefined)).toBe(90);
    expect(readRetentionDays('30')).toBe(90);
    expect(readRetentionDays(0)).toBe(90);
    expect(readRetentionDays(1.5)).toBe(90);
    expect(readRetentionDays(30)).toBe(30);
    expect(readRetentionDays(99999)).toBe(3650);
  });
});

describe('what a page loads', () => {
  it('adds the script and a pixel fallback with the path encoded', () => {
    const html = beaconHtml('/blog/a b?x=1');
    expect(html).toContain('<script src="/api/v1/plugins/analytics/script.js" defer></script>');
    expect(html).toContain('hit.gif?p=%2Fblog%2Fa%20b"');
    expect(html).toContain('<noscript>');
  });

  it('adds nothing for admin and API paths', () => {
    expect(beaconHtml('/admin/posts')).toBe('');
    expect(beaconHtml('/api/v1/x')).toBe('');
  });

  it('serves a script that respects Do Not Track and sets no cookie or storage', () => {
    expect(SCRIPT).toContain('doNotTrack');
    expect(SCRIPT).toContain('globalPrivacyControl');
    expect(SCRIPT).toContain('sendBeacon');
    expect(SCRIPT).not.toMatch(/cookie|localStorage|sessionStorage|indexedDB/i);
  });
});
