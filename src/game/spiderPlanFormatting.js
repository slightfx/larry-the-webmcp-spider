export function formatPlanArguments(args = {}) {
  return Object.entries(args)
    .filter(([key]) => !key.startsWith('_'))
    .map(([key, value]) => `${key.replaceAll('_', ' ')}=${String(value).toUpperCase()}`)
    .join(' · ');
}
