/**
 * "HEX" text icon — three letters in a monospace geek-font, sized to fill
 * the icon slot. We intentionally render wider than tall because three
 * letters in monospace don't fit a 1:1 square legibly.
 *
 *   width  = size * 1.6  (so HEX has horizontal room)
 *   height = size        (matches sibling lucide icons vertically)
 */
export function HexIcon({
  size = 14,
  strokeWidth: _strokeWidth = 1.75,
  ...rest
}: {
  size?: number | string;
  strokeWidth?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const h = typeof size === 'number' ? size : parseFloat(size);
  const w = Math.round(h * 1.6);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={w}
      height={h}
      viewBox="0 0 32 20"
      fill="currentColor"
      role="img"
      aria-label="Hex"
      {...rest}
    >
      <text
        x="16"
        y="16"
        textAnchor="middle"
        fontFamily="'Geist Mono Variable', ui-monospace, 'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Consolas, monospace"
        fontWeight="800"
        fontSize="18"
        letterSpacing="0.4"
        style={{ fontFeatureSettings: '"tnum" 1, "zero" 1' }}
      >
        HEX
      </text>
    </svg>
  );
}
