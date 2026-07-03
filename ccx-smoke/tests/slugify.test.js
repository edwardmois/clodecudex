import assert from 'node:assert/strict';
import test from 'node:test';

import { slugify } from '../src/slugify.js';

test('lowercases and trims surrounding whitespace', () => {
  assert.equal(slugify('  Hello World  '), 'hello-world');
});

test('turns consecutive whitespace into a single hyphen', () => {
  assert.equal(slugify('one   two\tthree\nfour'), 'one-two-three-four');
});

test('strips punctuation and symbols before creating the slug', () => {
  assert.equal(slugify('C# & JavaScript: 2026!'), 'c-javascript-2026');
});

test('preserves letters, numbers, and existing slug hyphens', () => {
  assert.equal(slugify('Release 2 Candidate-4'), 'release-2-candidate-4');
});

test('does not leave leading or trailing hyphens after stripping characters', () => {
  assert.equal(slugify('... Revenue + Profit ...'), 'revenue-profit');
});

test('returns an empty string when no alphanumeric characters remain', () => {
  assert.equal(slugify(' !@#$%^&*() '), '');
});

test('throws TypeError for non-string input', () => {
  assert.throws(() => slugify(null), TypeError);
});
