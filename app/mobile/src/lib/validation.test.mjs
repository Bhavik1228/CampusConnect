import test from 'node:test';
import assert from 'node:assert/strict';
import { canUseModule, classifyScan, isValidIsbn, normalizeIsbn } from './validation.ts';

test('normalizes ISBN separators and case', () => {
  assert.equal(normalizeIsbn('978-0-306-40615-7'), '9780306406157');
  assert.equal(normalizeIsbn('0-8044-2957-x'), '080442957X');
});

test('validates ISBN-10 and ISBN-13 checksums', () => {
  assert.equal(isValidIsbn('0-8044-2957-X'), true);
  assert.equal(isValidIsbn('9780306406157'), true);
  assert.equal(isValidIsbn('9780306406158'), false);
  assert.equal(isValidIsbn('1234567890'), false);
});

test('classifies supported visitor, ISBN, library barcode, and return scans', () => {
  assert.deepEqual(classifyScan('https://campusconnect.example/visitors/verify/123e4567-e89b-42d3-a456-426614174000'), {
    type: 'visitor',
    value: '123e4567-e89b-42d3-a456-426614174000',
  });
  assert.equal(classifyScan('9780306406157').type, 'isbn');
  assert.equal(classifyScan('LIB-12345678ABCDEF').type, 'library-barcode');
  assert.equal(classifyScan('1234567890ABCDEF').type, 'library-return');
  assert.equal(classifyScan('not-a-campus-code').type, 'unknown');
});

test('shows only modules that backend access returned as available', () => {
  const membership = {
    eligible: true,
    accessible_modules: ['visitors', 'notifications'],
  };
  assert.equal(canUseModule(membership, 'visitors'), true);
  assert.equal(canUseModule(membership, 'health'), false);
  assert.equal(canUseModule(null, 'visitors'), false);
});
