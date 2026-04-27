import { Handle, Position, type NodeProps } from '@xyflow/react';
import { graphTheme } from './theme.js';

/**
 * Custom React Flow node for memory nodes.
 *
 * Fixed width with left-aligned text and ellipsis overflow.
 * Handles on all four sides so edges connect to the nearest side.
 */
export function MemoryNode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';
  const fullTitle = typeof data.memory === 'object' && data.memory !== null && 'title' in data.memory
    ? String(data.memory.title)
    : label;

  return (
    <div
      title={fullTitle}
      style={{
        width: 260,
        padding: '8px 12px',
        background: graphTheme.memoryNode.background,
        border: `2px solid ${graphTheme.memoryNode.border}`,
        borderRadius: 6,
        fontFamily: graphTheme.fontFamily,
        color: graphTheme.memoryNode.text,
        fontSize: 12,
        fontWeight: 400,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        textAlign: 'left',
        boxSizing: 'border-box',
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
