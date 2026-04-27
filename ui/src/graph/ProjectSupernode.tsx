import type { NodeProps } from '@xyflow/react';
import { graphTheme } from './theme.js';

/**
 * Custom React Flow group node for project supernodes.
 *
 * Renders a colored header bar with the project display_name and a
 * semi-transparent body. Child nodes (concepts, memories) are positioned
 * inside automatically by React Flow — group nodes just render their own
 * visual container.
 *
 * No connection handles — the graph is read-only.
 */
export function ProjectSupernode({ data }: NodeProps) {
  const label = typeof data.label === 'string' ? data.label : '';

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        background: graphTheme.projectNode.background,
        border: `2px solid ${graphTheme.projectNode.border}`,
        borderRadius: 8,
        overflow: 'hidden',
        fontFamily: graphTheme.fontFamily,
      }}
    >
      <div
        style={{
          background: graphTheme.projectNode.headerBackground,
          color: graphTheme.projectNode.headerText,
          padding: '6px 12px',
          fontSize: 14,
          fontWeight: 600,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </div>
    </div>
  );
}
