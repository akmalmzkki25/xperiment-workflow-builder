import { describe, expect, test } from 'vitest';
import { ApiError } from '../src/lib/api';
import { forbiddenDetail } from '../src/lib/permissions';

describe('forbiddenDetail', () => {
  test('returns the problem detail for a permission 403', () => {
    const err = new ApiError(403, 'Forbidden', "Requires the 'workflow:read' permission");
    expect(forbiddenDetail(err)).toBe("Requires the 'workflow:read' permission");
  });

  test('falls back to the title when the problem carries no detail', () => {
    expect(forbiddenDetail(new ApiError(403, 'Forbidden'))).toBe('Forbidden');
  });

  test('ignores other statuses and non-ApiError failures', () => {
    expect(forbiddenDetail(new ApiError(404, 'Not found'))).toBeNull();
    expect(forbiddenDetail(new ApiError(401, 'Unauthorized'))).toBeNull();
    expect(forbiddenDetail(new Error('network down'))).toBeNull();
    expect(forbiddenDetail(null)).toBeNull();
  });
});
