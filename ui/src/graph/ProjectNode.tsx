import { Handle, Position, type NodeProps } from '@xyflow/react';
import { getNodeColors, graphTheme } from './theme.js';

/**
 * Project hub node — blue outline style.
 * Handles on all four sides for nearest-side edge routing.
 */
export function ProjectNode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';
  const isDark = typeof data.darkMode === 'boolean' ? data.darkMode : false;
  const colors = getNodeColors(isDark).project;

  return (
    <div
      title={label}
      style={{
        minWidth: 160,
        padding: '10px 20px',
        background: colors.background,
        color: colors.text,
        border: `2px solid ${colors.border}`,
        borderRadius: 10,
        fontFamily: graphTheme.fontFamily,
        fontSize: 14,
        fontWeight: 700,
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxSizing: 'border-box',
        boxShadow: `0 1px 4px ${colors.border}20`,
      }}
    >
      <Handle type="source" position={Position.Top} id="s-top" style={{ visibility: 'hidden' }} />
      <Handle type="source" position={Position.Bottom} id="s-bottom" style={{ visibility: 'hidden' }} />
      <Handle type="source" position={Position.Left} id="s-left" style={{ visibility: 'hidden' }} />
      <Handle type="source" position={Position.Right} id="s-right" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Top} id="t-top" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Bottom} id="t-bottom" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Left} id="t-left" style={{ visibility: 'hidden' }} />
      <Handle type="target" position={Position.Right} id="t-right" style={{ visibility: 'hidden' }} />
      {label}
    </div>
  );
}
