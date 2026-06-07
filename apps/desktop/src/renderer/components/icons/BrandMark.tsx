import logoUrl from '../../assets/logo.svg';

/**
 * Fineguide Tesseract brand mark — the app icon as a vector.
 *
 * `logo.svg` is an exact vectorisation (vtracer) of the source artwork, so the
 * in-app mark is pixel-faithful to the packaged icon (build/icon.{png,icns,ico}).
 *
 * `shimmer` glides a soft specular band diagonally across the gem — masked to
 * the gem silhouette and screen-blended — like light catching a polished stone.
 */
export function BrandMark({
  size = 18,
  shimmer = false,
  className,
  style,
}: {
  size?: number | string;
  shimmer?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const px = typeof size === 'number' ? `${size}px` : size;

  if (!shimmer) {
    return (
      <img
        src={logoUrl}
        width={size}
        height={size}
        alt="Fineguide Tesseract"
        draggable={false}
        className={className}
        style={{ display: 'block', width: px, height: px, ...style }}
      />
    );
  }

  const mask = `url(${logoUrl}) center / contain no-repeat`;
  return (
    <span
      className={`brandmark${className ? ` ${className}` : ''}`}
      style={{ width: px, height: px, ...style }}
    >
      <img
        src={logoUrl}
        width={size}
        height={size}
        alt="Fineguide Tesseract"
        draggable={false}
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
      <span
        className="brandmark__shine"
        aria-hidden
        style={{ WebkitMask: mask, mask }}
      >
        <span className="brandmark__glint" />
      </span>
    </span>
  );
}
