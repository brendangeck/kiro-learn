import type { NodeProps } from '@xyflow/react';
import { graphTheme } from './theme.js';

/**
 * Custom React Flow node for concept nodes.
 *
 * Renders a rounded rectangle labeled with the concept string.
 * Size scales with degree (`data.count`) — higher-degree concepts
 * are wider and taller so they stand out visually.
 *
 * All concept nodes share the same green color from the
 * Cloudscape-derived theme. No connection handles — the graph
 * is read-only.
 */
export function ConceptNode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';
  const count = typeof data.count === 'number' ? data.count : 1;

  // Scale dimensions with degree. Cap at reasonable maximums.
  const width = Math.min(120 + (count - 1) * 20, 300);
  const height = Math.min(36 + (count - 1) * 4, 80);

  return (
    <div
      style={{
        width,
        height,
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
      {label}
    </div>
  );
}
