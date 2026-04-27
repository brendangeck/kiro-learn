import { Handle, Position, type NodeProps } from '@xyflow/react';
import { graphTheme } from './theme.js';

/**
 * Custom React Flow node for project hub nodes.
 *
 * Handles on all four sides so edges connect to whichever side
 * is closest to the target node.
 */
export function ProjectSupernode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';

  return (
    <div
      title={label}
      style={{
        minWidth: 160,
        padding: '8px 16px',
        background: graphTheme.projectNode.headerBackground,
        color: graphTheme.projectNode.headerText,
        border: `2px solid ${graphTheme.projectNode.border}`,
        borderRadius: 8,
        fontFamily: graphTheme.fontFamily,
        fontSize: 14,
        fontWeight: 600,
        textAlign: 'center',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxSizing: 'border-box',
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
