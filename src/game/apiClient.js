const configuredBaseUrl = (() => {
  try {
    return import.meta.env?.VITE_API_BASE_URL || '';
  } catch {
    return '';
  }
})();

const API_BASE_URL = configuredBaseUrl.replace(/\/$/, '');

export function apiUrl(path) {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${API_BASE_URL}${normalizedPath}`;
}
