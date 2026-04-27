import { Handle, Position, type NodeProps } from '@xyflow/react';
import { graphTheme } from './theme.js';
import { NODE_DIMENSIONS } from './layout.js';

/** Base dimensions — must match what dagre uses for layout. */
const BASE = NODE_DIMENSIONS['conceptNode'] ?? { width: 140, height: 44 };

/**
 * Custom React Flow node for concept nodes.
 *
 * Renders a rounded rectangle labeled with the concept string.
 * Uses the same fixed dimensions that dagre allocates so rendering
 * and layout stay in sync.
 *
 * All concept nodes share the same green color from the
 * Cloudscape-derived theme. Handles are invisible but present
 * so React Flow can anchor edges.
 */
export function ConceptNode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';

  return (
    <div
      style={{
        width: BASE.width,
        height: BASE.height,
        background: graphTheme.conceptNode.background,
        border: `2px solid ${graphTheme.conceptNode.border}`,
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: graphTheme.fontFamily,
        color: graphTheme.conceptNode.text,
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
