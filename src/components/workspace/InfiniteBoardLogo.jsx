"use client";

export function InfiniteBoard({ size = 24 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect x="2" y="2" width="28" height="28" rx="7" fill="#10b981" fillOpacity="0.14" stroke="#10b981" strokeWidth="1.6" />
      <path d="M8 20c3-8 6-8 8-2s5 6 8-2" stroke="#10b981" strokeWidth="2.2" strokeLinecap="round" />
      <circle cx="10" cy="11" r="2" fill="#10b981" />
    </svg>
  );
}
