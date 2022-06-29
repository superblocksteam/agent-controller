export function sanitizeAgentKey(key: string): string {
  return key.replace(/\//g, '__');
}
