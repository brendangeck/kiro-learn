import { Handle, Position, type NodeProps } from '@xyflow/react';
import { getPalette, graphTheme } from './theme.js';

/**
 * Custom React Flow node for project hub nodes.
 *
 * Uses the project's assigned color from the palette.
 * Saturated background with white text for prominence.
 * Handles on all four sides for nearest-side edge routing.
 */
export function ProjectSupernode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';
  const colorIndex = typeof data.colorIndex === 'number' ? data.colorIndex : 0;
  const isDark = typeof data.darkMode === 'boolean' ? data.darkMode : false;
  const palette = getPalette(isDark);
  const scheme = palette[colorIndex % palette.length]!;

  return (
    <div
      title={label}
      style={{
        minWidth: 160,
        padding: '10px 20px',
        background: scheme.border,
        color: scheme.textInverse,
        border: `2px solid ${scheme.border}`,
        borderRadius: 10,
        fontFamily: graphTheme.fontFamily,
        fontSize: 14,
        fontWeight: 700,
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxSizing: 'border-box',
        boxShadow: `0 2px 8px ${scheme.border}40`,
      }}
    >
      <Handle type="source" position={Position.Top} id="s-top" style={{ visibility: 'hidden' }} />
      <Handle type="source" position={Position.Bottom} id="s-bottom" style={{ visibility: 'hidden' }} />
      <Handle type="source" position={Position.Left} id="s-left" style={{ visibility: 'hidden' }} />
      <Handle type="source" position={Position.Right} id="s-right" style={{ visibility: 'hidden' }} />
      {label}
    </div>
  );
}
