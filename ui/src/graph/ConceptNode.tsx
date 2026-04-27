import { Handle, Position, type NodeProps } from '@xyflow/react';
import { getNodeColors, graphTheme } from './theme.js';

/**
 * Concept node — mint/green outline style.
 * Handles on all four sides for nearest-side edge routing.
 */
export function ConceptNode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';
  const isDark = typeof data.darkMode === 'boolean' ? data.darkMode : false;
  const colors = getNodeColors(isDark).concept;

  return (
    <div
      title={label}
      style={{
        minWidth: 100,
        padding: '6px 14px',
        background: colors.background,
        border: `2px solid ${colors.border}`,
        borderRadius: 8,
        fontFamily: graphTheme.fontFamily,
        color: colors.text,
        fontSize: 12,
        fontWeight: 500,
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
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
