import Box from '@cloudscape-design/components/box';
import SpaceBetween from '@cloudscape-design/components/space-between';

/**
 * Color legend for the memory graph.
 *
 * Palette ported from the cosmos.gl `point-labels` demo. Two node kinds
 * visually: projects (pink hubs, labeled) and everything else (blue-purple
 * leaves). Memory and concept nodes share a color, matching the demo's
 * theater-vs-performance distinction.
 */
export function GraphLegend(_props: { darkMode?: boolean }) {
  const items = [
    { label: 'Project', color: '#ED69B4' },
    { label: 'Memory / Concept', color: '#4B5BBF' },
  ];

  return (
    <SpaceBetween direction="horizontal" size="m">
      {items.map(({ label, color }) => (
        <Box key={label} fontSize="body-s" color="text-body-secondary">
          <span
            style={{
              display: 'inline-block',
              width: 12,
              height: 12,
              borderRadius: 6,
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
