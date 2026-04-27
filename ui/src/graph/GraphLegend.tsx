import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { graphTheme } from './theme.js';

/**
 * Color legend for the memory graph.
 *
 * Shows a compact horizontal row mapping each node-type color to its
 * label: Project (blue), Concept (green), Memory (amber). Uses
 * Cloudscape layout components so the legend feels native to the page.
 *
 * Validates: Requirements 5.5, 10.4
 */

const items: readonly { readonly label: string; readonly color: string }[] = [
  { label: 'Project', color: graphTheme.projectNode.border },
  { label: 'Memory', color: graphTheme.memoryNode.border },
] as const;

export function GraphLegend() {
  return (
    <SpaceBetween direction="horizontal" size="m">
      {items.map(({ label, color }) => (
        <Box key={label} fontSize="body-s" color="text-body-secondary">
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 2,
              background: color,
              marginRight: 6,
              verticalAlign: 'middle',
            }}
          />
          {label}
        </Box>
      ))}
    </SpaceBetween>
  );
}
