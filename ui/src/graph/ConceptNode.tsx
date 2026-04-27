import { Handle, Position, type NodeProps } from '@xyflow/react';
import { PROJECT_PALETTE, graphTheme } from './theme.js';

/**
 * Custom React Flow node for concept nodes.
 *
 * Currently unused in the graph (concepts are shown as tags in the
 * detail panel instead), but kept as a valid component for potential
 * future use.
 */
export function ConceptNode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';
  const scheme = PROJECT_PALETTE[4]!; // Emerald by default

  return (
    <div
      style={{
        width: 140,
        height: 44,
        background: scheme.background,
        border: `2px solid ${scheme.border}`,
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: graphTheme.fontFamily,
        color: scheme.text,
        fontSize: 13,
        fontWeight: 500,
        padding: '0 10px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        boxSizing: 'border-box',
      }}
    >
      <Handle type="target" position={Position.Top} style={{ visibility: 'hidden' }} />
      {label}
      <Handle type="source" position={Position.Bottom} style={{ visibility: 'hidden' }} />
    </div>
  );
}
