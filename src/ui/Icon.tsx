import type { ReactNode, SVGProps } from 'react';

/**
 * Inline stroke icons.
 *
 * No icon font and no webfont request: the app runs offline on phones in a yard,
 * and a blocked font request would leave every button unlabelled.
 */
const PATHS = {
  matrix: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18M3 15h18M9 3v18" />
    </>
  ),
  jobs: (
    <>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </>
  ),
  entry: (
    <>
      <path d="M3 20h18" />
      <path d="M5 20v-8l4-3v3l4-3v3l4-3v11" />
      <path d="M5 12V6h4v6" />
    </>
  ),
  log: (
    <>
      <path d="M4 5h16M4 10h16M4 15h10M4 20h7" />
    </>
  ),
  curing: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  blast: (
    <>
      <path d="M12 3l1.8 4.4L18 9l-4.2 1.6L12 15l-1.8-4.4L6 9l4.2-1.6z" />
      <path d="M18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z" />
    </>
  ),
  myob: (
    <>
      <path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z" />
      <circle cx="7" cy="18.5" r="1.8" />
      <circle cx="17" cy="18.5" r="1.8" />
    </>
  ),
  schedule: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </>
  ),
  products: (
    <>
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" />
      <path d="M4 7.5l8 4.5 8-4.5M12 12v9" />
    </>
  ),
  sources: (
    <>
      <path d="M12 3v10m0 0l3.5-3.5M12 13L8.5 9.5" />
      <path d="M4 16v3a2 2 0 002 2h12a2 2 0 002-2v-3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
  cloud: (
    <>
      <path d="M7 18h10a3.5 3.5 0 000-7 5 5 0 00-9.6 1.3A3 3 0 007 18z" />
    </>
  ),
  cloudOff: (
    <>
      <path d="M7 18h10a3.5 3.5 0 001.2-6.8" />
      <path d="M12.5 6.6A5 5 0 004.4 11 3 3 0 005 17" />
      <path d="M3.5 3.5l17 17" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M6 6l1.4 1.4M16.6 16.6L18 18M18 6l-1.4 1.4M7.4 16.6L6 18" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z" />,
  chevronDown: <path d="M6 9.5l6 5 6-5" />,
  chevronRight: <path d="M9.5 6l5 6-5 6" />,
  chevronLeft: <path d="M14.5 6l-5 6 5 6" />,
  chevronUp: <path d="M6 14.5l6-5 6 5" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  check: <path d="M4.5 12.5l5 5 10-11" />,
  alert: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  grip: (
    <>
      <path d="M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5L20 20" />
    </>
  ),
  filter: <path d="M4 6h16l-6 7v6l-4-2v-4z" />,
  sort: (
    <>
      <path d="M7 4v16M7 20l-3-3M7 20l3-3" />
      <path d="M17 20V4M17 4l-3 3M17 4l3 3" />
    </>
  ),
  undo: (
    <>
      <path d="M4 10h9a5 5 0 010 10H8" />
      <path d="M4 10l4-4M4 10l4 4" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 10-2.3 5.7" />
      <path d="M20 20v-5h-5" />
    </>
  ),
  more: (
    <>
      <path d="M6 12h.01M12 12h.01M18 12h.01" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
    </>
  ),
  pin: (
    <>
      <path d="M12 3v8M8 11h8l1.5 4h-11z" />
      <path d="M12 15v6" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v11m0 0l4-4M12 14l-4-4" />
      <path d="M4 19h16" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4m0 0L8 8M12 4l4 4" />
      <path d="M4 19h16" />
    </>
  ),
  pencil: (
    <>
      <path d="M4 20h4L20 8l-4-4L4 16z" />
      <path d="M14.5 5.5l4 4" />
    </>
  ),
  columns: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9.5 4v16M15 4v16" />
    </>
  ),
  save: (
    <>
      <path d="M4 5h12l4 4v10H4z" />
      <path d="M8 5v5h7M8 15h8" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c1.5-3.5 4-5 7-5s5.5 1.5 7 5" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4" />
    </>
  ),
  history: (
    <>
      <path d="M4 12a8 8 0 108-8 8 8 0 00-6.3 3" />
      <path d="M4 4v4h4" />
      <path d="M12 8v4.5l3.5 2" />
    </>
  ),
  split: (
    <>
      <path d="M4 6h4l6 6h6M4 18h4l6-6" />
      <path d="M17 3.5L20.5 6 17 8.5M17 15.5L20.5 18 17 20.5" />
    </>
  ),
  play: <path d="M8 5.5l11 6.5-11 6.5z" />,
  pause: <path d="M9 5v14M15 5v14" />,
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  /** CSS pixels. 16 in dense tables, 20-24 for touch targets. */
  size?: number;
  strokeWidth?: number;
}

export function Icon({ name, size = 16, strokeWidth = 1.7, ...rest }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Screens read the button's text, not the picture.
      aria-hidden="true"
      focusable="false"
      style={{ flex: '0 0 auto' }}
      {...rest}
    >
      {PATHS[name] as ReactNode}
    </svg>
  );
}
