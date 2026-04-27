import { Handle, Position, type NodeProps } from '@xyflow/react';
import { getPalette, graphTheme } from './theme.js';

/**
 * Custom React Flow node for memory nodes.
 *
 * Inherits its project's color from the palette.
 * Tinted background with saturated border and dark text.
 * Handles on all four sides for nearest-side edge routing.
 */
export function MemoryNode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';
  const colorIndex = typeof data.colorIndex === 'number' ? data.colorIndex : 0;
  const isDark = typeof data.darkMode === 'boolean' ? data.darkMode : false;
  const palette = getPalette(isDark);
  const scheme = palette[colorIndex % palette.length]!;
  const fullTitle = typeof data.memory === 'object' && data.memory !== null && 'title' in data.memory
    ? String(data.memory.title)
    : label;

  return (
    <div
      title={fullTitle}
      style={{
        width: 260,
        padding: '8px 12px',
        background: scheme.background,
        border: `2px solid ${scheme.border}`,
        borderRadius: 8,
        fontFamily: graphTheme.fontFamily,
        color: scheme.text,
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        textAlign: 'left',
        boxSizing: 'border-box',
        boxShadow: `0 1px 4px ${scheme.border}20`,
      }}
    >
      <Handle type="target" position={Position.Top} id="t-top" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Bottom} id="t-bottom" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Left} id="t-left" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Right} id="t-right" style={{ visibility: 'hidden' }} />
      {label}
    </div>
  );
}
