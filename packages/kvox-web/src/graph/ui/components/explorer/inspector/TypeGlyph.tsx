import { encodingFor, type ExplorerMode } from '../explorerEncoding.js';
import { PICTOGRAMS, type PictogramName } from '../icons/pictograms.js';

/**
 * Props of {@link TypeGlyph}.
 *
 * @stability experimental
 */
export interface TypeGlyphProps {
  /** The node's type key: an entity type or an item kind. */
  type: string;
  /** Light or dark variant of the colour. */
  mode: ExplorerMode;
  /** Diameter in px. Default 32. */
  size?: number;
}

/**
 * A node type as the canvas draws it: a coloured disc with the type's pictogram. Decorative: the type's label always sits next to it.
 *
 * @stability experimental
 */
export function TypeGlyph({ type, mode, size = 32 }: TypeGlyphProps) {
  const encoding = encodingFor(type, mode);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden focusable="false" style={{ flexShrink: 0 }}>
      <circle cx={12} cy={12} r={12} fill={encoding.color} />
      <g transform="translate(4.8 4.8) scale(0.6)">
        <path d={PICTOGRAMS[encoding.icon as PictogramName]} fill={encoding.iconColor} fillRule="evenodd" />
      </g>
    </svg>
  );
}
