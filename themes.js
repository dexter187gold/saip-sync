/** Shared theme pack for admin console (v6.1) */
export const THEMES = [
  { id: 'midnight', label: 'Midnight Pro' },
  { id: 'aurora', label: 'Aurora' },
  { id: 'ocean', label: 'Ocean Depth' },
  { id: 'sunset', label: 'Sunset Heat' },
  { id: 'forest', label: 'Forest SA' },
  { id: 'rose', label: 'Rose Glass' },
  { id: 'slate', label: 'Slate Minimal' },
  { id: 'light', label: 'Daylight' },
  { id: 'sand', label: 'Warm Sand' },
  { id: 'neon', label: 'Neon Cyber' },
];

const VARS = {
  midnight: { bg: '#0b1220', elevated: '#111827', text: '#e5e7eb', muted: '#94a3b8', border: 'rgba(148,163,184,.18)', primary: '#38bdf8' },
  aurora: { bg: '#0f0a1a', elevated: '#1a1030', text: '#f3e8ff', muted: '#c4b5fd', border: 'rgba(167,139,250,.22)', primary: '#a78bfa' },
  ocean: { bg: '#0a1628', elevated: '#0f2137', text: '#e0f2fe', muted: '#7dd3fc', border: 'rgba(56,189,248,.2)', primary: '#0ea5e9' },
  sunset: { bg: '#1a0f0a', elevated: '#2a1810', text: '#ffedd5', muted: '#fdba74', border: 'rgba(251,146,60,.22)', primary: '#f97316' },
  forest: { bg: '#0a1410', elevated: '#102018', text: '#ecfdf5', muted: '#6ee7b7', border: 'rgba(16,185,129,.22)', primary: '#10b981' },
  rose: { bg: '#1a0a12', elevated: '#2a1220', text: '#fce7f3', muted: '#f9a8d4', border: 'rgba(244,114,182,.22)', primary: '#ec4899' },
  slate: { bg: '#0f1115', elevated: '#181b22', text: '#e8eaed', muted: '#9aa0a6', border: 'rgba(154,160,166,.18)', primary: '#8ab4f8' },
  light: { bg: '#f4f6f9', elevated: '#ffffff', text: '#0f172a', muted: '#64748b', border: 'rgba(15,23,42,.1)', primary: '#007A4D' },
  sand: { bg: '#f5f0e6', elevated: '#fffaf0', text: '#3f2e1e', muted: '#8b7355', border: 'rgba(63,46,30,.12)', primary: '#b45309' },
  neon: { bg: '#050508', elevated: '#0c0c14', text: '#e2e8f0', muted: '#94a3b8', border: 'rgba(34,211,238,.25)', primary: '#22d3ee' },
};

export function applyAdminTheme(id) {
  const t = VARS[id] || VARS.midnight;
  const r = document.documentElement;
  r.setAttribute('data-theme', id === 'light' || id === 'sand' ? 'light' : 'dark');
  r.style.setProperty('--bg', t.bg);
  r.style.setProperty('--bg-elevated', t.elevated);
  r.style.setProperty('--surface', t.elevated);
  r.style.setProperty('--text', t.text);
  r.style.setProperty('--text-secondary', t.muted);
  r.style.setProperty('--muted', t.muted);
  r.style.setProperty('--border', t.border);
  r.style.setProperty('--primary', t.primary);
  r.style.setProperty('--primary-soft', t.primary.replace(')', ',.15)').replace('rgb', 'rgba').replace('#', '') && `color-mix(in srgb, ${t.primary} 15%, transparent)`);
  try { localStorage.setItem('sa_admin_theme', id); } catch {}
}

export function loadAdminTheme() {
  try {
    applyAdminTheme(localStorage.getItem('sa_admin_theme') || 'midnight');
  } catch {
    applyAdminTheme('midnight');
  }
}
