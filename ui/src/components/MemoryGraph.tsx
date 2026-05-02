import { useCallback, useMemo } from 'react';

import Spinner from '@cloudscape-design/components/spinner';
import StatusIndicator from '@cloudscape-design/components/status-indicator';
import Box from '@cloudscape-design/components/box';

import { transform, type NodeId, type NodeKind, type ProjectInfo } from '../graph/transform.js';
import { getPackedTheme } from '../graph/theme.js';
import { CosmosGraph } from './CosmosGraph.js';
import { GraphLegend } from '../graph/GraphLegend.js';
import type { MemoryRecord } from '../types/api.js';

/**
 * Outer shell for the memory graph.
 *
 * Deliberately minimal. No filter checkboxes, no label selection, no local
 * focus/hover state — `CosmosGraph` owns its own exploration state via the
 * engine's `setConfigPartial`. This component owns data transformation,
 * loading/error/empty placeholders, click routing to the detail panel,
 * and the color legend.
 */
interface MemoryGraphProps {
  memories: MemoryRecord[];
  projects: ProjectInfo[];
  loading: boolean;
  error: string | null;
  darkMode: boolean;
  onNodeClick: (memory: MemoryRecord | null, concept: string | null) => void;
}

export function MemoryGraph({
  memories,
  projects,
  loading,
  error,
  darkMode,
  onNodeClick,
}: MemoryGraphProps) {
  const theme = useMemo(() => getPackedTheme(darkMode), [darkMode]);
  const data = useMemo(() => transform(memories, projects, theme), [memories, projects, theme]);

  const handleClick = useCallback(
    (id: NodeId | null, kind: NodeKind | null) => {
      if (id === null || kind === null) {
        onNodeClick(null, null);
        return;
      }
      if (kind === 'memory') {
        const recordId = id.slice('memory:'.length);
        onNodeClick(memories.find((m) => m.record_id === recordId) ?? null, null);
      } else if (kind === 'concept') {
        // Concept id shape: `concept:<namespace>:<concept>`. Split on the
        // last `:` so namespaces containing `:` round-trip correctly.
        const rest = id.slice('concept:'.length);
        const sep = rest.lastIndexOf(':');
        onNodeClick(null, sep >= 0 ? rest.slice(sep + 1) : rest);
      }
      // Project clicks: focus the point visually (cosmos.gl handles that
      // internally) but don't open the detail panel.
    },
    [memories, onNodeClick],
  );

  if (loading) {
    return (
      <Box textAlign="center" padding={{ vertical: 'xxl' }}>
        <Spinner size="large" />
        <Box variant="p" color="text-body-secondary" margin={{ top: 's' }}>
          Loading graph...
        </Box>
      </Box>
    );
  }
  if (error) {
    return (
      <Box textAlign="center" padding={{ vertical: 'xxl' }}>
        <StatusIndicator type="error">Failed to load memories</StatusIndicator>
      </Box>
    );
  }
  if (memories.length === 0) {
    return (
      <Box textAlign="center" padding={{ vertical: 'xxl' }} color="text-body-secondary">
        No memories yet — run some sessions to see your graph
      </Box>
    );
  }

  return (
    <>
      <Box margin={{ bottom: 's' }}>
        <GraphLegend darkMode={darkMode} />
      </Box>
      <div style={{ height: 500 }}>
        <CosmosGraph
          data={data}
          backgroundColor={theme.backgroundColor}
          onPointClick={handleClick}
        />
      </div>
    </>
  );
}
