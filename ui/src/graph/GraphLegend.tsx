import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { getNodeColors } from './theme.js';

/**
 * Color legend for the memory graph.
 */
export function GraphLegend({ darkMode = false }: { darkMode?: boolean }) {
  const colors = getNodeColors(darkMode);

  const items = [
    { label: 'Project', border: colors.project.border, bg: colors.project.background },
    { label: 'Concept', border: colors.concept.border, bg: colors.concept.background },
    { label: 'Memory', border: colors.memory.border, bg: colors.memory.background },
  ];

  return (
    <SpaceBetween direction="horizontal" size="m">
      {items.map(({ label, border, bg }) => (
        <Box key={label} fontSize="body-s" color="text-body-secondary">
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 2,
              background: bg,
              border: `1px solid ${border}`,
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
