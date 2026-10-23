/**
 * Symbole der Bausteine (24er-Raster, Linien), aus vollholz/assets `web/src/ui/icons.ts`. Eine App mit eigenen Symbolen
 * ersetzt sie über `components.Icon` und muss diese Namen kennen (`IamIconName`).
 */
export const ICONS = {
  arrow: "<path d=\"M5 12h14M13 6l6 6-6 6\"/>",
  building: "<rect x=\"4\" y=\"3\" width=\"16\" height=\"18\" rx=\"1\"/><path d=\"M9 7h.01M15 7h.01M9 11h.01M15 11h.01M9 15h.01M15 15h.01M10 21v-3h4v3\"/>",
  check: "<path d=\"M5 12l5 5 9-10\"/>",
  chev: "<path d=\"M9 6l6 6-6 6\"/>",
  clock: "<circle cx=\"12\" cy=\"12\" r=\"9\"/><path d=\"M12 7v5l3 2\"/>",
  cog: "<circle cx=\"12\" cy=\"12\" r=\"3\"/><path d=\"M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1\"/>",
  copy: "<rect x=\"8\" y=\"8\" width=\"12\" height=\"12\" rx=\"1.5\"/><path d=\"M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3\"/>",
  down: "<path d=\"M12 5v14M6 13l6 6 6-6\"/>",
  edit: "<path d=\"M4 20h4L19 9l-4-4L4 16z\"/>",
  eye: "<path d=\"M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z\"/><circle cx=\"12\" cy=\"12\" r=\"3\"/>",
  inbox: "<path d=\"M3 13l3-8h12l3 8v6H3z\"/><path d=\"M3 13h5l1 3h6l1-3h5\"/>",
  key: "<circle cx=\"8\" cy=\"15\" r=\"4\"/><path d=\"M11 12l9-9M17 6l3 3M15 8l2 2\"/>",
  lock: "<rect x=\"5\" y=\"11\" width=\"14\" height=\"10\" rx=\"1.5\"/><path d=\"M8 11V7a4 4 0 018 0v4\"/>",
  layers: "<path d=\"M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5\"/>",
  link: "<path d=\"M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1\"/>",
  more: "<circle cx=\"5\" cy=\"12\" r=\"1.2\"/><circle cx=\"12\" cy=\"12\" r=\"1.2\"/><circle cx=\"19\" cy=\"12\" r=\"1.2\"/>",
  plug: "<path d=\"M9 2v5M15 2v5M6 7h12v4a6 6 0 01-12 0zM12 17v5\"/>",
  plus: "<path d=\"M12 5v14M5 12h14\"/>",
  reset: "<path d=\"M4 12a8 8 0 1 0 2.3-5.7M4 4v4h4\"/>",
  search: "<circle cx=\"11\" cy=\"11\" r=\"7\"/><path d=\"M20 20l-3.5-3.5\"/>",
  send: "<path d=\"M21 3L10 14M21 3l-7 18-4-7-7-4z\"/>",
  shield: "<path d=\"M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z\"/>",
  tag: "<path d=\"M3 12V3h9l9 9-9 9z\"/><circle cx=\"7.5\" cy=\"7.5\" r=\"1.5\"/>",
  trash: "<path d=\"M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13\"/>",
  up: "<path d=\"M12 19V5M6 11l6-6 6 6\"/>",
  user: "<circle cx=\"12\" cy=\"8\" r=\"4\"/><path d=\"M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6\"/>",
  users: "<circle cx=\"9\" cy=\"8\" r=\"3.5\"/><path d=\"M2 20c1-3.5 3.8-5 7-5s6 1.5 7 5M16 4.5a3.5 3.5 0 010 7M18 15c2 .6 3.4 2.2 4 5\"/>",
  warn: "<path d=\"M12 3l10 18H2z\"/><path d=\"M12 10v5M12 18h.01\"/>",
  x: "<path d=\"M6 6l12 12M18 6L6 18\"/>",
} as const;

export type IamIconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IamIconName[];
