import type { NodeProps } from '@xyflow/react';
import { graphTheme } from './theme.js';

/**
 * Custom React Flow node for memory nodes.
 *
 * Renders a small rectangle labeled with the memory title (already
 * truncated to ~40 chars by the transform function). All memory nodes
 * share the same amber color from the Cloudscape-derived theme.
 *
 * `observation_type` is stored in `data.memory.observation_type` for
 * the detail panel but does NOT affect node color.
 *
 * No connection handles — the graph is read-only.
 */
export function MemoryNode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';

  return (
    <div
      style={{
        width: 130,
        height: 36,
        background: graphTheme.memoryNode.background,
        border: `2px solid ${graphTheme.memoryNode.border}`,
        borderRadius: 4,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: graphTheme.fontFamily,
        color: graphTheme.memoryNode.text,
        fontSize: 12,
        fontWeight: 400,
        padding: '0 8px',
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
