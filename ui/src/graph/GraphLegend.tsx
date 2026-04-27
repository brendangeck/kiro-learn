import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';
import { getPalette } from './theme.js';

/**
 * Color legend for the memory graph.
 *
 * Shows Project (saturated) and Memory (tinted) styling using the
 * first palette color as an example.
 */
export function GraphLegend({ darkMode = false }: { darkMode?: boolean }) {
  const palette = getPalette(darkMode);
  const first = palette[0]!;

  const items = [
    { label: 'Project', color: first.border },
    { label: 'Memory', color: first.background, borderColor: first.border },
  ];

  return (
    <SpaceBetween direction="horizontal" size="m">
      {items.map(({ label, color, borderColor }) => (
        <Box key={label} fontSize="body-s" color="text-body-secondary">
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 2,
              background: color,
              border: borderColor ? `1px solid ${borderColor}` : undefined,
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
