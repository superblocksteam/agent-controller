import { sanitizeAgentKey } from './file';

describe('sanitizeAgentKey', () => {
  it('mulitple slashes', async () => {
    expect(sanitizeAgentKey('are/you/serious')).toBe('are__you__serious');
  });
  it('slash at beginning', async () => {
    expect(sanitizeAgentKey('/are/you/serious')).toBe('__are__you__serious');
  });
  it('slash at end', async () => {
    expect(sanitizeAgentKey('are/you/serious/')).toBe('are__you__serious__');
  });
});
