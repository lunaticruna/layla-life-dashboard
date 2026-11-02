const paths = {
  leaf: '<path d="M20 4C11 3 4 7 5 14c1 5 7 7 11 3 3-3 3-8 4-13Z"/><path d="M4 21 15 10"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  book: '<path d="M4 4h7a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4V4Z"/><path d="M14 7a3 3 0 0 1 3-3h4v14h-3a4 4 0 0 0-4 3"/>',
  brain: '<path d="M12 4a4 4 0 0 0-7-1 4 4 0 0 0-2 7 5 5 0 0 0 2 8 4 4 0 0 0 7 2V4Zm0 0a4 4 0 0 1 7-1 4 4 0 0 1 2 7 5 5 0 0 1-2 8 4 4 0 0 1-7 2"/><path d="M7 7c3 0 3 3 1 4m9-4c-3 0-3 3-1 4M7 16h2m6 0h2"/>',
  settings: '<path d="m10 3-1 3-3 1-3-1-2 4 2 2v3l-2 2 2 4 3-1 3 1 1 3h4l1-3 3-1 3 1 2-4-2-2v-3l2-2-2-4-3 1-3-1-1-3Z" transform="translate(0 -1) scale(.95)"/><circle cx="12" cy="12" r="3"/>',
  moon: '<path d="M20 15A9 9 0 0 1 9 4a9 9 0 1 0 11 11Z"/><path d="m17 3 .4 1.6L19 5l-1.6.4L17 7l-.4-1.6L15 5l1.6-.4L17 3Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/>',
  heart: '<path d="M20 5a5 5 0 0 0-8 1 5 5 0 0 0-8-1c-5 5 2 11 8 15 6-4 13-10 8-15Z"/>',
  cloud: '<path d="M6 18a5 5 0 1 1 1-10 6 6 0 0 1 11 2 4 4 0 0 1 0 8H6Z"/>',
  health: '<path d="M12 21s-9-5-9-11a5 5 0 0 1 9-3 5 5 0 0 1 9 3c0 6-9 11-9 11Z"/><path d="M7 12h3l1-3 2 6 1-3h3"/>',
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  refresh: '<path d="M20 8V3l-3 3a8 8 0 1 0 3 10M20 8h-5"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3ZM20 2v4m-2-2h4"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  check: '<path d="m5 12 4 4 10-10"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  edit: '<path d="m15 4 5 5M4 20l5-1L21 7l-5-5L4 14v6Z"/>',
  bolt: '<path d="m13 2-9 12h7l-1 8 10-12h-7l1-8Z"/>',
  cup: '<path d="M4 7h12v9a5 5 0 0 1-10 0V7m10 2h2a3 3 0 0 1 0 6h-2M3 22h16M8 2v2m4-2v2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v1"/>',
  flow: '<path d="M7 3v18m0-14h9V3m-9 9h9v8"/><circle cx="7" cy="5" r="2"/><circle cx="7" cy="12" r="2"/><circle cx="7" cy="20" r="2"/><circle cx="16" cy="4" r="2"/><circle cx="16" cy="20" r="2"/>'
};
export const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.leaf}</svg>`;
export const room = `<svg viewBox="0 0 220 170" fill="none" aria-hidden="true"><rect x="62" y="16" width="104" height="106" rx="52" fill="#e1eae3"/><path d="M68 121V63a46 46 0 0 1 92 0v58" fill="#f9fbf5" stroke="#b6cbbb" stroke-width="2"/><path d="M114 19v103M69 69h90" stroke="#c6d8cc" stroke-width="2"/><circle cx="140" cy="47" r="10" fill="#e8cd91"/><path d="M73 106c28-20 59-9 86-20v35H70Z" fill="#dae7dd"/><path d="M71 121h91" stroke="#9cb7a4" stroke-width="4" stroke-linecap="round"/><rect x="35" y="128" width="151" height="7" rx="3.5" fill="#a99e8c"/><path d="M44 135v26m134-26v26" stroke="#b4a897" stroke-width="5"/><rect x="80" y="115" width="41" height="6" rx="2" fill="#849f97"/><rect x="86" y="121" width="38" height="7" rx="2" fill="#d4b383"/><path d="M139 117h16v11h-16v-11Zm16 1h3a4 4 0 0 1 0 7h-3" fill="#f3e9d7" stroke="#bba98b" stroke-width="1.5"/><path d="M49 127v-18m0 8c-18 1-16-17-16-17 16-2 16 17 16 17Zm0-5c17-2 13-20 13-20-14 0-13 20-13 20Z" fill="#8fa791"/><path d="m40 122 3 12h12l3-12" fill="#cfb99a"/><path d="M145 111c-6-5 3-7-1-12" stroke="#c1b2a1" stroke-linecap="round"/></svg>`;
