import { Handle, Position, type NodeProps } from '@xyflow/react';
import { getNodeColors, graphTheme } from './theme.js';

/**
 * Memory node — pink/salmon outline style.
 * Handles on all four sides for nearest-side edge routing.
 */
export function MemoryNode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';
  const isDark = typeof data.darkMode === 'boolean' ? data.darkMode : false;
  const colors = getNodeColors(isDark).memory;
  const fullTitle = typeof data.memory === 'object' && data.memory !== null && 'title' in data.memory
    ? String(data.memory.title)
    : label;

  return (
    <div
      title={fullTitle}
      style={{
        width: 260,
        padding: '8px 12px',
        background: colors.background,
        color: colors.text,
        border: `2px solid ${colors.border}`,
        borderRadius: 8,
        fontFamily: graphTheme.fontFamily,
        fontSize: 12,
        fontWeight: 500,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        textAlign: 'left',
        boxSizing: 'border-box',
        boxShadow: `0 1px 4px ${colors.border}20`,
      }}
    >
      <Handle type="target" position={Position.Top} id="t-top" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Bottom} id="t-bottom" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Left} id="t-left" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Right} id="t-right" style={{ visibility: 'hidden' }} />
      <Handle type="source" position={Position.Top} id="s-top" style={{ visibility: 'hidden' }} />
      <Handle type="source" position={Position.Bottom} id="s-bottom" style={{ visibility: 'hidden' }} />
      <Handle type="source" position={Position.Left} id="s-left" style={{ visibility: 'hidden' }} />
      <Handle type="source" position={Position.Right} id="s-right" style={{ visibility: 'hidden' }} />
      {label}
    </div>
  );
}
