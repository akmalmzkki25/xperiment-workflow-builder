import { describe, expect, test } from 'vitest';
import {
  choiceFromParams,
  isKnownChoice,
  paramsForChoice,
  statusesFor,
  STATUS_CHOICES,
} from '../src/lib/executionFilter';

describe('STATUS_CHOICES', () => {
  test('ALL asks for no predicate at all', () => {
    expect(statusesFor('ALL')).toBeUndefined();
  });

  test('Problems is one look at both failure statuses', () => {
    // "Did anything break?" is one question, and it is only expressible now that the
    // predicate runs on the server.
    expect(statusesFor('PROBLEMS')).toEqual(['FAILED', 'TIMED_OUT']);
  });

  test('every non-ALL choice names at least one status', () => {
    for (const choice of STATUS_CHOICES.filter((c) => c.value !== 'ALL')) {
      expect(choice.statuses, choice.value).toBeDefined();
      expect(choice.statuses!.length, choice.value).toBeGreaterThan(0);
    }
  });

  test('values are unique, so the select cannot have two identical options', () => {
    const values = STATUS_CHOICES.map((c) => c.value);
    expect(new Set(values).size).toBe(values.length);
  });

  test('an unknown choice sends no predicate rather than a guess', () => {
    expect(statusesFor('SOMETHING_ELSE')).toBeUndefined();
    expect(isKnownChoice('SOMETHING_ELSE')).toBe(false);
  });
});

describe('choiceFromParams', () => {
  test('reads a known value out of the URL', () => {
    expect(choiceFromParams('FAILED')).toBe('FAILED');
  });

  test('a missing or unknown value falls back to ALL', () => {
    expect(choiceFromParams(null)).toBe('ALL');
    expect(choiceFromParams(undefined)).toBe('ALL');
    expect(choiceFromParams('')).toBe('ALL');
    expect(choiceFromParams('DROP TABLE')).toBe('ALL');
  });
});

describe('paramsForChoice', () => {
  test('a filtered view is a link somebody can send', () => {
    expect(paramsForChoice('FAILED')).toBe('?status=FAILED');
    expect(paramsForChoice('PROBLEMS', 'wf-1')).toBe('?workflowId=wf-1&status=PROBLEMS');
  });

  test('ALL leaves the URL clean rather than writing status=ALL', () => {
    expect(paramsForChoice('ALL')).toBe('');
    expect(paramsForChoice('ALL', 'wf-1')).toBe('?workflowId=wf-1');
  });

  test('an unknown choice is not written to the URL', () => {
    expect(paramsForChoice('NONSENSE')).toBe('');
  });

  test('round-trips through the URL', () => {
    for (const choice of STATUS_CHOICES) {
      const qs = paramsForChoice(choice.value);
      const parsed = new URLSearchParams(qs.replace(/^\?/, '')).get('status');
      expect(choiceFromParams(parsed), choice.value).toBe(choice.value);
    }
  });
});
